// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {RevertingValidator} from "../mocks/RevertingValidator.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @notice The account's authorization guarantees must not depend on which
/// execution environment invoked it.
///
/// @dev ERC-4337 arrives through `validateUserOp`; the EntryPoint-independent
/// path arrives through `executeDirect`. Both funnel into the same internal
/// boundary (`_validateAuthority` and `_executeAuthorized`), and this file is
/// what keeps that true: it asserts the same refusal from both sides rather
/// than testing each path's plumbing separately, so a future environment added
/// per `docs/decisions/0020-execution-environment-boundary.md` inherits the
/// same assertions by construction.
///
/// This test contract is the EntryPoint, as elsewhere in the suite: the account
/// is constructed with `address(this)` as its execution environment.
contract ExecutionEnvironmentParityTest {
    LoomAccount internal account;
    MockValidator internal validator;
    RevertingValidator internal revertingValidator;
    MockTarget internal target;

    function setUp() public {
        validator = new MockValidator();
        revertingValidator = new RevertingValidator();
        target = new MockTarget();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }

    function _userOp(address signingValidator, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory userOp)
    {
        userOp.sender = address(account);
        userOp.callData = callData;
        userOp.signature = abi.encode(signingValidator, bytes(""));
    }

    function _singleCall() internal view returns (bytes memory) {
        return abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (7))));
    }

    /// The installed-module check lives inside the canonical boundary, so an
    /// uninstalled validator has to be refused identically on both paths. The
    /// two refusals differ in shape by design: ERC-4337 requires validation to
    /// return a failure code rather than revert, while the direct path has no
    /// such constraint and reverts.
    function testUninstalledValidatorIsRejectedByEveryEnvironment() public {
        MockValidator uninstalled = new MockValidator();
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, address(uninstalled)), "validator was installed");

        uint256 validationData = account.validateUserOp(_userOp(address(uninstalled), ""), keccak256("op"), 0);
        require(
            validationData == ValidationDataLib.SIG_VALIDATION_FAILED, "4337 path accepted an uninstalled validator"
        );

        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.executeDirect,
                    (address(uninstalled), account.SINGLE_EXECUTION_MODE(), _singleCall(), type(uint48).max, "")
                )
            );
        require(!ok, "direct path accepted an uninstalled validator");
        require(target.value() == 0, "uninstalled validator moved account state");
    }

    /// A validator that reverts must be caught and mapped to a failure code, not
    /// bubbled out of validation. Recorded as MEDIUM-04 in
    /// docs/reviews/preliminary-review-disposition.md.
    function testRevertingValidatorFailsClosedInsteadOfBubbling() public {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(revertingValidator), "");
        LoomAccount unreachable =
            new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        PackedUserOperation memory userOp = _userOp(address(revertingValidator), "");
        userOp.sender = address(unreachable);

        uint256 validationData = unreachable.validateUserOp(userOp, keccak256("op"), 0);
        require(validationData == ValidationDataLib.SIG_VALIDATION_FAILED, "reverting validator was not failed closed");
    }

    /// A signature envelope that is not `(address,bytes)` must fail closed
    /// rather than revert, or a malformed operation would be indistinguishable
    /// from an account-level fault to the EntryPoint.
    function testMalformedSignatureEnvelopeFailsClosed() public {
        PackedUserOperation memory userOp = _userOp(address(validator), "");
        userOp.signature = hex"deadbeef";

        uint256 validationData = account.validateUserOp(userOp, keccak256("op"), 0);
        require(validationData == ValidationDataLib.SIG_VALIDATION_FAILED, "malformed envelope was not failed closed");
    }

    /// `validateUserOp` is reachable only from a registered execution
    /// environment. The account itself is not one: self-calls reach execution
    /// through `execute`, never through validation.
    function testValidationIsReachableOnlyFromAnExecutionEnvironment() public {
        PackedUserOperation memory userOp = _userOp(address(validator), "");
        (bool ok,) =
            address(new Caller()).call(abi.encodeCall(Caller.validate, (address(account), userOp, keccak256("op"))));
        require(!ok, "a non-environment caller reached validation");
    }

    /// `execute` accepts a registered environment or the account itself, and
    /// nothing else. This is the single predicate a second environment extends.
    function testExecutionIsReachableOnlyFromAnEnvironmentOrSelf() public {
        (bool ok,) = address(new Caller())
            .call(abi.encodeCall(Caller.execute, (address(account), account.SINGLE_EXECUTION_MODE(), _singleCall())));
        require(!ok, "a non-environment caller reached execution");
        require(target.value() == 0, "unauthorized caller moved account state");

        account.execute(account.SINGLE_EXECUTION_MODE(), _singleCall());
        require(target.value() == 7, "the registered environment could not execute");
    }

    /// The direct-execution digest has to name the exact call it authorizes, or
    /// an engine could validate one operation and submit another. Each field is
    /// varied on its own so a digest that silently stopped covering one of them
    /// fails here rather than in review.
    function testDirectExecutionDigestBindsEveryFieldItClaimsTo() public view {
        bytes32 single = account.SINGLE_EXECUTION_MODE();
        bytes memory call = _singleCall();
        bytes32 base = account.directExecutionDigest(address(validator), single, call, 0, type(uint48).max);

        require(
            base != account.directExecutionDigest(address(revertingValidator), single, call, 0, type(uint48).max),
            "digest ignores the validator"
        );
        require(
            base
                != account.directExecutionDigest(
                    address(validator), account.BATCH_EXECUTION_MODE(), call, 0, type(uint48).max
                ),
            "digest ignores the execution mode"
        );
        require(
            base
                != account.directExecutionDigest(
                    address(validator),
                    single,
                    abi.encode(ExecutionLib.Execution(address(target), 0, abi.encodeCall(MockTarget.setValue, (8)))),
                    0,
                    type(uint48).max
                ),
            "digest ignores the execution calldata"
        );
        require(
            base != account.directExecutionDigest(address(validator), single, call, 1, type(uint48).max),
            "digest ignores the nonce"
        );
        require(
            base != account.directExecutionDigest(address(validator), single, call, 0, type(uint48).max - 1),
            "digest ignores the expiry"
        );
    }

    /// The digest is account-scoped through the EIP-712 domain, so the same
    /// authorization cannot be relayed against a different Loom account.
    function testDirectExecutionDigestIsBoundToThisAccount() public {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount other = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        bytes32 single = account.SINGLE_EXECUTION_MODE();
        bytes memory call = _singleCall();

        require(
            account.directExecutionDigest(address(validator), single, call, 0, type(uint48).max)
                != other.directExecutionDigest(address(validator), single, call, 0, type(uint48).max),
            "two accounts share a direct-execution authorization"
        );
    }

    /// Execution-mode support is decided below the boundary, so both paths
    /// refuse an unsupported mode for the same reason rather than each
    /// re-deciding it.
    function testUnsupportedModeIsRejectedByEveryEnvironment() public {
        bytes32 delegateCallMode = bytes32(uint256(0xff) << 248);

        (bool viaEnvironment,) =
            address(account).call(abi.encodeCall(LoomAccount.execute, (delegateCallMode, _singleCall())));
        require(!viaEnvironment, "environment path accepted an unsupported mode");

        (bool viaDirect,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.executeDirect,
                    (address(validator), delegateCallMode, _singleCall(), type(uint48).max, "")
                )
            );
        require(!viaDirect, "direct path accepted an unsupported mode");
        require(target.value() == 0, "unsupported mode moved account state");
    }
}

/// @dev A plain external caller, so "not the EntryPoint and not the account"
/// is exercised through a real `msg.sender` rather than a cheatcode.
contract Caller {
    function validate(address account, PackedUserOperation calldata userOp, bytes32 hash) external {
        LoomAccount(payable(account)).validateUserOp(userOp, hash, 0);
    }

    function execute(address account, bytes32 mode, bytes calldata executionCalldata) external {
        LoomAccount(payable(account)).execute(mode, executionCalldata);
    }
}
