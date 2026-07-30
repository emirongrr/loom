// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomValidatorFactory} from "../../src/LoomValidatorFactory.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {RecoveryManager} from "../../src/recovery/RecoveryManager.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

interface VmProvisioning {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// @notice Recovery can provision its new validator without any privileged service.
/// @dev Recovery replaces the whole validator set and rejects a `newValidator` that
/// is already installed. Loom's validators are multi-tenant, so recovering to a new
/// credential of the same kind needs a second deployment of the same code at a
/// different address. Nothing in the repository provided one, and the reference
/// wallet filled the gap with a backend endpoint that spends an operator key --
/// making recovery depend on a hosted service, which the walkaway guarantee forbids.
///
/// These tests show the whole ceremony working with no such service: the address is
/// computed offline, an unrelated stranger deploys it, guardians sign over it, and
/// the deployer ends up with no authority over the account or the instance.
contract PermissionlessValidatorProvisioningTest {
    VmProvisioning internal constant vm = VmProvisioning(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant GUARDIAN_KEY = 0xB0B;
    uint256 internal constant NEW_OWNER_KEY = 0xC0FFEE;
    address internal constant STRANGER = address(0xDEADBEEF);
    bytes32 internal constant ROTATED_ROOT = keccak256("rotated-guardian-root");

    LoomValidatorFactory internal factory;
    ECDSAGuardianVerifier internal guardianVerifier;
    RecoveryManager internal recovery;
    PolicyHook internal hook;
    ECDSAValidator internal oldValidator;
    LoomAccount internal account;

    bytes32 internal keyCommitment;
    bytes32 internal guardianSalt;
    bytes32 internal guardianLeaf;

    function setUp() public {
        factory = new LoomValidatorFactory();
        guardianVerifier = new ECDSAGuardianVerifier();
        recovery = new RecoveryManager();
        hook = new PolicyHook();
        oldValidator = new ECDSAValidator();

        keyCommitment = keccak256(abi.encode(vm.addr(GUARDIAN_KEY)));
        guardianSalt = keccak256("guardian-salt");
        guardianLeaf = keccak256(
            abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, guardianSalt)
        );

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](3);
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(oldValidator),
            abi.encodeCall(ECDSAValidator.initialize, (vm.addr(OWNER_KEY), address(hook)))
        );
        modules[2] = LoomAccount.ModuleInit(ModuleType.RECOVERY, address(recovery), "");
        // This test contract stands in for the EntryPoint.
        account = new LoomAccount(address(this), guardianLeaf, 1, keccak256("config"), modules);
    }

    /// @notice The end-to-end ceremony with no operator key anywhere in it.
    function testStrangerCanProvisionTheRecoveryValidatorAndRecoverySucceeds() public {
        bytes memory creationCode = type(ECDSAValidator).creationCode;
        uint64 recoveryNonce = recovery.recoveryNonces(address(account));

        // 1. The address is known before it exists, so guardians can commit to it.
        address predicted = factory.predict(address(account), recoveryNonce, keccak256(creationCode));
        require(predicted.code.length == 0, "instance should not exist yet");

        // 2. Anyone deploys it. A stranger with no relationship to the account will do.
        vm.prank(STRANGER);
        address deployed = factory.deploy(address(account), recoveryNonce, creationCode);
        require(deployed == predicted, "deployed address did not match the prediction");
        require(deployed.code.length != 0, "instance was not deployed");

        // 3. The guardian threshold proposes recovery onto it, and it executes.
        bytes memory initData = abi.encodeCall(ECDSAValidator.initialize, (vm.addr(NEW_OWNER_KEY), address(hook)));
        _proposeAndExecute(deployed, initData);

        require(account.validatorCount() == 1, "validator set not replaced");
        require(account.validatorAt(0) == deployed, "recovered validator is not the provisioned instance");
        require(account.guardianRoot() == ROTATED_ROOT, "guardian root not rotated");

        // The recovered account authorizes with the new owner's key.
        require(
            account.validateUserOp(_signedUserOp(deployed, NEW_OWNER_KEY), _opHash(), 0) == 0,
            "recovered account cannot validate with the new credential"
        );
    }

    /// @notice Deploying grants the deployer nothing.
    /// @dev The factory never calls `initialize`, and validator state is keyed by the
    /// caller. Only the account can bind the instance to itself, which it does from
    /// inside `recoverConfiguration`.
    function testDeployerGainsNoAuthorityOverTheInstanceOrTheAccount() public {
        bytes memory creationCode = type(ECDSAValidator).creationCode;
        uint64 recoveryNonce = recovery.recoveryNonces(address(account));

        vm.prank(STRANGER);
        address deployed = factory.deploy(address(account), recoveryNonce, creationCode);

        // The instance is unbound: it holds no owner for the account.
        require(ECDSAValidator(deployed).owners(address(account)) == address(0), "instance pre-bound to the account");
        require(ECDSAValidator(deployed).policyHooks(address(account)) == address(0), "instance pre-bound a hook");

        // A stranger may initialize it for *themselves*, which binds nothing for the
        // account: validator state is keyed by `msg.sender`.
        vm.prank(STRANGER);
        ECDSAValidator(deployed).initialize(STRANGER, address(hook));
        require(ECDSAValidator(deployed).owners(STRANGER) == STRANGER, "self-initialization did not apply");
        require(ECDSAValidator(deployed).owners(address(account)) == address(0), "stranger bound the account's slot");

        // Recovery onto that same instance still works and installs the account's own
        // owner, so a squatter cannot spoil the instance.
        bytes memory initData = abi.encodeCall(ECDSAValidator.initialize, (vm.addr(NEW_OWNER_KEY), address(hook)));
        _proposeAndExecute(deployed, initData);
        require(
            ECDSAValidator(deployed).owners(address(account)) == vm.addr(NEW_OWNER_KEY),
            "recovery did not bind the account's own owner"
        );
        require(account.validatorAt(0) == deployed, "recovery did not install the instance");
    }

    /// @notice Racing to provision the same recovery converges instead of failing.
    function testRepeatedDeploymentIsIdempotent() public {
        bytes memory creationCode = type(ECDSAValidator).creationCode;
        uint64 recoveryNonce = recovery.recoveryNonces(address(account));

        vm.prank(STRANGER);
        address first = factory.deploy(address(account), recoveryNonce, creationCode);
        vm.prank(address(0xFEE1));
        address second = factory.deploy(address(account), recoveryNonce, creationCode);
        require(first == second, "second deployment produced a different instance");
    }

    /// @notice Different code, account, or recovery lands at a different address.
    /// @dev Constructor arguments are part of the creation code, so a validator built
    /// against different inputs cannot be substituted at the expected address.
    function testAddressBindsAccountRecoveryNonceAndExactCreationCode() public view {
        bytes memory creationCode = type(ECDSAValidator).creationCode;
        bytes32 codeHash = keccak256(creationCode);

        address base = factory.predict(address(account), 0, codeHash);
        require(base != factory.predict(address(account), 1, codeHash), "recovery nonce not bound");
        require(base != factory.predict(address(0xABCD), 0, codeHash), "account not bound");
        require(base != factory.predict(address(account), 0, keccak256("different creation code")), "code not bound");
    }

    /// @notice Each recovery gets a distinct instance, so the "already installed"
    /// rule never blocks a later recovery.
    function testSecondRecoveryProvisionsADistinctInstance() public {
        bytes memory creationCode = type(ECDSAValidator).creationCode;

        uint64 firstNonce = recovery.recoveryNonces(address(account));
        address first = factory.deploy(address(account), firstNonce, creationCode);
        _proposeAndExecute(first, abi.encodeCall(ECDSAValidator.initialize, (vm.addr(NEW_OWNER_KEY), address(hook))));

        uint64 secondNonce = recovery.recoveryNonces(address(account));
        require(secondNonce != firstNonce, "recovery nonce did not advance");
        address second = factory.deploy(address(account), secondNonce, creationCode);
        require(second != first, "second recovery reused the installed instance");
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, second), "second instance already installed");
    }

    function testDeployRejectsEmptyCreationCode() public {
        (bool ok,) = address(factory).call(abi.encodeCall(LoomValidatorFactory.deploy, (address(account), 0, "")));
        require(!ok, "empty creation code accepted");
    }

    // --- helpers ---

    function _proposeAndExecute(address newValidator, bytes memory initData) internal {
        address[] memory oldValidators = new address[](1);
        oldValidators[0] = account.validatorAt(0);

        uint64 nonce = recovery.recoveryNonces(address(account));
        bytes32 proposal = recovery.proposalDigest(
            address(account),
            keccak256(abi.encode(oldValidators)),
            newValidator,
            keccak256(initData),
            ROTATED_ROOT,
            1,
            account.configVersion(),
            nonce
        );
        recovery.proposeRecovery(
            address(account),
            oldValidators,
            newValidator,
            keccak256(initData),
            ROTATED_ROOT,
            1,
            _guardianApprovals(proposal)
        );
        (,,,,, uint48 readyAt,,,) = recovery.pendingRecoveries(address(account));
        vm.warp(readyAt);
        recovery.executeRecovery(address(account), oldValidators, initData);
    }

    function _opHash() internal pure returns (bytes32) {
        return keccak256("op");
    }

    function _signedUserOp(address signingValidator, uint256 key) internal returns (PackedUserOperation memory op) {
        op = PackedUserOperation({
            sender: address(account),
            nonce: 0,
            initCode: "",
            callData: "",
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: "",
            signature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _opHash());
        op.signature = abi.encode(signingValidator, abi.encodePacked(r, s, v));
    }

    function _guardianApprovals(bytes32 digest) internal returns (GuardianVerificationLib.Approval[] memory approvals) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GUARDIAN_KEY, digest);
        approvals = new GuardianVerificationLib.Approval[](1);
        approvals[0] = GuardianVerificationLib.Approval({
            verifier: address(guardianVerifier),
            keyCommitment: keyCommitment,
            salt: guardianSalt,
            signature: abi.encodePacked(r, s, v),
            proof: new bytes32[](0)
        });
    }
}
