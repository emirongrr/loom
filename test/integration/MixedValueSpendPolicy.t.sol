// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockPayableERC20} from "../mocks/MockPayableERC20.sol";

interface VmMixedValue {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 amount) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

/// @notice Regression coverage for native value attached to ERC-20-shaped calldata.
/// @dev A token-shaped call carrying `msg.value` moves two assets at once.
/// `PolicyHook` used to read only the decoded token amount and discard
/// `execution.value`, so the attached ETH was metered by nothing: the policy it
/// consults is keyed by `policyId(target, tokenSelector)`, while a native policy on
/// the same target is keyed by the empty selector and is never read.
///
/// That mattered beyond accounting. `_spendAmount` also feeds
/// `_isLowRiskExecution`, and `isLowRisk` is the only authorization gate in
/// `ECDSAValidator`, `P256Validator`, and `MultiP256Validator`
/// `validateDirectExecution`. A signer bounded to a small token allowance could
/// therefore attach arbitrary ETH from the account balance and still be classified
/// low risk, which is a direct-execution authority bypass rather than a
/// mis-metering.
///
/// `VaultHook` already treated the shape as dangerous. These tests pin the same
/// fail-closed classification for `PolicyHook` on every path that reaches it.
contract MixedValueSpendPolicyTest {
    VmMixedValue internal constant vm = VmMixedValue(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint128 internal constant TOKEN_LIMIT = 100;
    address internal constant RECIPIENT = address(0xBEEF);

    PolicyHook internal hook;
    ECDSAValidator internal validator;
    LoomAccount internal account;
    MockPayableERC20 internal token;
    address internal owner;

    function setUp() public {
        hook = new PolicyHook();
        validator = new ECDSAValidator();
        owner = vm.addr(OWNER_KEY);

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
        // This test contract stands in for the EntryPoint so `execute` is callable.
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);

        token = new MockPayableERC20();
        token.mint(address(account), 1_000);
        vm.deal(address(account), 10 ether);

        // Token policy only. There is deliberately no native policy, which is what
        // made a discarded `value` completely unmetered.
        _setPolicy(address(token), MockPayableERC20.transfer.selector, TOKEN_LIMIT);
    }

    function testPlainTokenTransferUnderLimitStillFlows() public {
        _execute(address(token), 0, abi.encodeCall(MockPayableERC20.transfer, (RECIPIENT, 40)));

        require(token.balanceOf(RECIPIENT) == 40, "plain token transfer blocked");
        require(_spent() == 40, "plain token spend not metered");
    }

    function testEthAttachedTokenCallIsRejectedAndMovesNothing() public {
        uint256 accountEthBefore = address(account).balance;

        // The token amount is far under the per-call limit, so only the attached
        // value can be the reason this must fail.
        bytes memory mixed = abi.encodeCall(MockPayableERC20.transfer, (RECIPIENT, 1));
        (bool ok, bytes memory revertData) = _tryExecute(address(token), 1 ether, mixed);

        require(!ok, "ETH-attached token call bypassed the policy hook");
        require(
            keccak256(revertData) == keccak256(abi.encodeWithSelector(PolicyHook.LimitExceeded.selector)),
            "wrong rejection: mixed spend was not metered as unbounded"
        );
        require(address(account).balance == accountEthBefore, "account ETH moved");
        require(address(token).balance == 0, "ETH reached the token");
        require(token.balanceOf(RECIPIENT) == 0, "tokens moved");
        require(_spent() == 0, "rejected mixed call consumed budget");
    }

    /// @notice The authority consequence: `isLowRisk` gates `validateDirectExecution`.
    function testMixedSpendIsNotLowRiskAndCannotDirectExecute() public {
        bytes memory mixed = abi.encodeCall(MockPayableERC20.transfer, (RECIPIENT, 1));
        bytes memory mixedCalldata = abi.encode(ExecutionLib.Execution(address(token), 1 ether, mixed));
        bytes memory plainCalldata = abi.encode(
            ExecutionLib.Execution(address(token), 0, abi.encodeCall(MockPayableERC20.transfer, (RECIPIENT, 1)))
        );

        require(
            !hook.isLowRisk(address(account), _accountCall(mixedCalldata)),
            "mixed native and token spend classified low risk"
        );
        require(
            hook.isLowRisk(address(account), _accountCall(plainCalldata)),
            "plain in-limit token spend should stay low risk"
        );

        uint256 accountEthBefore = address(account).balance;
        uint256 nonceBefore = account.directExecutionNonces(address(validator));

        // A correctly signed direct execution still fails, because the validator
        // asks the hook whether the call is low risk before accepting it.
        (bool ok,) = _tryDirectExecute(mixedCalldata);
        require(!ok, "mixed spend passed direct execution authority");
        require(address(account).balance == accountEthBefore, "account ETH moved through direct execution");
        require(token.balanceOf(RECIPIENT) == 0, "tokens moved through direct execution");
        require(
            account.directExecutionNonces(address(validator)) == nonceBefore, "rejected direct execution consumed nonce"
        );

        // The same signer can still direct-execute the plain in-limit call, so the
        // guard narrows the bypass rather than disabling the path.
        (bool plainOk,) = _tryDirectExecute(plainCalldata);
        require(plainOk, "plain in-limit direct execution rejected");
        require(token.balanceOf(RECIPIENT) == 1, "plain direct execution did not move tokens");
    }

    function testMixedSpendInBatchRejectsWholeBatchAtomically() public {
        bytes memory plain = abi.encodeCall(MockPayableERC20.transfer, (RECIPIENT, 10));
        bytes memory mixed = abi.encodeCall(MockPayableERC20.transfer, (RECIPIENT, 1));
        ExecutionLib.Execution[] memory items = new ExecutionLib.Execution[](2);
        items[0] = ExecutionLib.Execution(address(token), 0, plain);
        items[1] = ExecutionLib.Execution(address(token), 1 ether, mixed);

        (bool ok, bytes memory revertData) = address(account)
            .call(abi.encodeCall(LoomAccount.execute, (account.BATCH_EXECUTION_MODE(), abi.encode(items))));

        require(!ok, "batch containing a mixed spend succeeded");
        require(
            keccak256(revertData) == keccak256(abi.encodeWithSelector(PolicyHook.LimitExceeded.selector)),
            "wrong batch rejection"
        );
        require(token.balanceOf(RECIPIENT) == 0, "batch was not atomic");
        require(_spent() == 0, "rejected batch consumed budget");
    }

    /// @notice The scheduled path routes through the same hook, so it must agree.
    function testScheduledMixedSpendIsRejectedByTheSameClassification() public {
        bytes memory mixed = abi.encodeCall(MockPayableERC20.transfer, (RECIPIENT, 1));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(token), 1 ether, mixed, account.MIN_EXTERNAL_DELAY()));
        _execute(address(account), 0, schedule);
        vm.warp(block.timestamp + account.MIN_EXTERNAL_DELAY());

        (bool ok, bytes memory revertData) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(token), 1 ether, mixed)));

        require(!ok, "scheduled mixed spend bypassed the policy hook");
        require(
            keccak256(revertData) == keccak256(abi.encodeWithSelector(PolicyHook.LimitExceeded.selector)),
            "wrong scheduled rejection"
        );
        require(token.balanceOf(RECIPIENT) == 0, "scheduled mixed spend moved tokens");
    }

    /// @notice Malformed token calldata plus value must not fall back to metering
    /// the native amount against the token policy's per-call limit.
    function testMalformedTokenCalldataWithValueIsRejected() public {
        bytes memory malformed = abi.encodePacked(MockPayableERC20.transfer.selector, hex"1234");
        (bool ok,) = _tryExecute(address(token), 1, malformed);
        require(!ok, "malformed token calldata with value accepted");
        require(_spent() == 0, "malformed mixed call consumed budget");
    }

    /// @notice A native-only spend is unchanged: it carries no token selector, so
    /// the guard does not reclassify it. The recipient is a codeless address because
    /// `MockPayableERC20` accepts ETH only alongside a `transfer` call, which is
    /// precisely the shape the guard rejects.
    function testNativeOnlySpendIsUnaffected() public {
        uint256 before = RECIPIENT.balance;
        _execute(RECIPIENT, 1 ether, "");
        require(RECIPIENT.balance == before + 1 ether, "native-only spend blocked");
    }

    // --- helpers ---

    function _accountCall(bytes memory executionCalldata) internal view returns (bytes memory) {
        return abi.encodeCall(LoomAccount.execute, (account.SINGLE_EXECUTION_MODE(), executionCalldata));
    }

    function _execute(address target, uint256 value, bytes memory data) internal {
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(target, value, data)));
    }

    function _tryExecute(address target, uint256 value, bytes memory data)
        internal
        returns (bool ok, bytes memory revertData)
    {
        (ok, revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute, (bytes32(0), abi.encode(ExecutionLib.Execution(target, value, data)))
                )
            );
    }

    function _tryDirectExecute(bytes memory executionCalldata) internal returns (bool ok, bytes memory revertData) {
        uint48 validUntil = type(uint48).max;
        bytes32 digest = account.directExecutionDigest(
            address(validator),
            account.SINGLE_EXECUTION_MODE(),
            executionCalldata,
            account.directExecutionNonces(address(validator)),
            validUntil
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        (ok, revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.executeDirect,
                    (
                        address(validator),
                        account.SINGLE_EXECUTION_MODE(),
                        executionCalldata,
                        validUntil,
                        abi.encodePacked(r, s, v)
                    )
                )
            );
    }

    function _setPolicy(address target, bytes4 selector, uint128 limit) internal {
        PolicyHook.Policy memory policy = PolicyHook.Policy(limit, limit, 1 days, RECIPIENT, true);
        bytes memory setPolicy = abi.encodeCall(PolicyHook.setPolicy, (target, selector, policy));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(hook), 0, setPolicy, account.MIN_CONFIG_DELAY()));
        _execute(address(account), 0, schedule);
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(hook), 0, setPolicy);
    }

    function _spent() internal view returns (uint128 amount) {
        (amount,) = hook.spending(address(account), hook.policyId(address(token), MockPayableERC20.transfer.selector));
    }

    receive() external payable {}
}
