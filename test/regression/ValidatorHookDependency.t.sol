// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {MockValidator} from "../mocks/MockValidator.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

interface VmDep {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// @notice A hook a validator depends on cannot be removed out from under it.
/// @dev Every built-in primary validator stores a policy-hook address per account
/// and fails closed when that hook is not installed. Nothing used to connect those
/// two facts: `_uninstallModule` had no dependency check, and
/// `evictHookWithGuardians` removed a hook immediately.
///
/// That left a terminal state. With the account's only hook evicted, its validator
/// could no longer pass `validateUserOp` or `validateDirectExecution`;
/// `setPolicyHook` needs a scheduled self-call that only a passing validator can
/// reach; and guardian recovery installs validators but not hooks, so it could not
/// repair the account either. ADR-0005's acceptance evidence for hook eviction used
/// `MockValidator`, which has no policy-hook binding at all, so this configuration
/// was never exercised.
///
/// The account now refuses to remove a depended-on hook, and the guardian eviction
/// path takes a replacement, so a stuck hook can still be escaped -- atomically,
/// without stranding the account.
contract ValidatorHookDependencyTest {
    VmDep internal constant vm = VmDep(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SIG_VALIDATION_FAILED = ValidationDataLib.SIG_VALIDATION_FAILED;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant GUARDIAN_KEY = 0xB0B;

    ECDSAGuardianVerifier internal guardianVerifier;
    bytes32 internal keyCommitment;
    bytes32 internal guardianSalt;
    bytes32 internal guardianLeaf;
    address internal owner;

    PolicyHook internal hook;
    ECDSAValidator internal validator;
    LoomAccount internal account;

    function setUp() public {
        guardianVerifier = new ECDSAGuardianVerifier();
        owner = vm.addr(OWNER_KEY);
        keyCommitment = keccak256(abi.encode(vm.addr(GUARDIAN_KEY)));
        guardianSalt = keccak256("guardian-salt");
        guardianLeaf = keccak256(
            abi.encode(address(guardianVerifier), address(guardianVerifier).codehash, keyCommitment, guardianSalt)
        );

        hook = new PolicyHook();
        validator = new ECDSAValidator();

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](2);
        // Hook first. Module initialization runs inside the account's install loop,
        // and the validator now requires its hook to already be installed.
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
        // This test contract stands in for the EntryPoint.
        account = new LoomAccount(address(this), guardianLeaf, 1, keccak256("config"), modules);
    }

    function testAccountValidatesWhileTheBoundHookIsInstalled() public {
        require(account.validateUserOp(_signedUserOp(address(validator)), _opHash(), 0) == 0, "baseline validation");
        require(account.policyHookDependency(address(validator)) == address(hook), "dependency not reported");
    }

    /// @notice A validator cannot be installed pointing at a hook that is not there.
    /// @dev Closes the door on an account that is incoherent from birth.
    function testValidatorCannotInitializeAgainstAnUninstalledHook() public {
        PolicyHook absent = new PolicyHook();
        ECDSAValidator fresh = new ECDSAValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(fresh), abi.encodeCall(ECDSAValidator.initialize, (owner, address(absent)))
        );
        (bool ok,) = address(this).call(abi.encodeCall(this.deployAccount, (modules)));
        require(!ok, "validator initialized against an uninstalled hook");
    }

    function deployAccount(LoomAccount.ModuleInit[] calldata modules) external returns (LoomAccount) {
        return new LoomAccount(address(this), guardianLeaf, 1, keccak256("other"), modules);
    }

    /// @notice Guardians cannot evict a depended-on hook without naming a
    /// replacement, and the refused attempt changes nothing.
    function testEvictionWithoutReplacementIsRefusedWhenAValidatorDependsOnTheHook() public {
        bytes32 digest = account.evictHookDigest(address(hook), address(0), account.configVersion());
        (bool ok, bytes memory revertData) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.evictHookWithGuardians, (address(hook), address(0), _guardianApprovals(digest))
                )
            );
        require(!ok, "evicted a hook the only validator depends on");
        require(
            keccak256(revertData) == keccak256(abi.encodeWithSelector(LoomAccount.HookHasDependentValidator.selector)),
            "wrong rejection"
        );

        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "refused eviction removed the hook");
        require(
            account.validateUserOp(_signedUserOp(address(validator)), _opHash(), 0) == 0,
            "refused eviction disturbed validation"
        );
    }

    /// @notice The escape hatch still works: a stuck hook is swapped atomically.
    /// @dev This keeps ADR-0005's guarantee intact. Guardians can still escape a
    /// malicious or broken hook without the account's cooperation; they just have to
    /// say what replaces it.
    function testGuardiansCanSwapAStuckHookForAWorkingOneAtomically() public {
        PolicyHook replacement = new PolicyHook();
        uint64 versionBefore = account.configVersion();

        bytes32 digest = account.evictHookDigest(address(hook), address(replacement), account.configVersion());
        account.evictHookWithGuardians(address(hook), address(replacement), _guardianApprovals(digest));

        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook)), "stuck hook not evicted");
        require(account.isModuleInstalled(ModuleType.HOOK, address(replacement)), "replacement not installed");
        require(
            account.policyHookDependency(address(validator)) == address(replacement),
            "validator not rebound onto the replacement"
        );
        require(account.configVersion() == versionBefore + 1, "eviction did not advance config");
        require(!account.isEvictingHook(), "eviction flag left set");

        // The account is still usable, which is the whole point.
        require(
            account.validateUserOp(_signedUserOp(address(validator)), _opHash(), 0) == 0,
            "account unusable after a hook swap"
        );
    }

    /// @notice Eviction without a replacement stays available when nothing depends on
    /// the hook, so the guard does not make the escape hatch harder than it needs to be.
    function testEvictionWithoutReplacementStillWorksForAnUndependedHook() public {
        PolicyHook spare = new PolicyHook();
        _scheduleAndRun(abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(spare), "")));

        bytes32 digest = account.evictHookDigest(address(spare), address(0), account.configVersion());
        account.evictHookWithGuardians(address(spare), address(0), _guardianApprovals(digest));

        require(!account.isModuleInstalled(ModuleType.HOOK, address(spare)), "undepended hook not evicted");
        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "wrong hook removed");
    }

    /// @notice The ordinary uninstall path is guarded too, not only guardian eviction.
    function testScheduledUninstallOfADependedHookIsRefused() public {
        bytes memory uninstall = abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(hook), ""));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, uninstall, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());

        (bool ok,) =
            address(account).call(abi.encodeCall(LoomAccount.executeScheduled, (address(account), 0, uninstall)));
        require(!ok, "scheduled uninstall removed a depended-on hook");
        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "hook removed by scheduled uninstall");
    }

    /// @notice Rebinding is reachable only during a guardian eviction.
    /// @dev Otherwise it would be an instant, untimelocked way to re-point a validator
    /// at a permissive hook, bypassing `setPolicyHook`'s configuration delay.
    function testRebindPolicyHookIsRejectedOutsideAnEviction() public {
        PolicyHook other = new PolicyHook();
        _scheduleAndRun(abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(other), "")));
        require(!account.isEvictingHook(), "account should not be evicting");

        (bool direct,) = address(validator).call(abi.encodeCall(ECDSAValidator.rebindPolicyHook, (address(other))));
        require(!direct, "rebind accepted from an arbitrary caller");

        (bool viaAccount,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.execute,
                    (
                        bytes32(0),
                        abi.encode(
                            ExecutionLib.Execution(
                                address(validator), 0, abi.encodeCall(ECDSAValidator.rebindPolicyHook, (address(other)))
                            )
                        )
                    )
                )
            );
        require(!viaAccount, "rebind accepted outside an eviction");
        require(account.policyHookDependency(address(validator)) == address(hook), "dependency changed");
    }

    /// @notice A validator that declares no dependency is unaffected.
    function testValidatorsWithoutAPolicyHookReportNoDependency() public {
        MockValidator plain = new MockValidator();
        require(account.policyHookDependency(address(plain)) == address(0), "unexpected dependency reported");
    }

    // --- helpers ---

    function _opHash() internal pure returns (bytes32) {
        return keccak256("op");
    }

    function _signedUserOp(address signingValidator) internal returns (PackedUserOperation memory op) {
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, _opHash());
        op.signature = abi.encode(signingValidator, abi.encodePacked(r, s, v));
    }

    function _scheduleAndRun(bytes memory data) internal {
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, data, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, data);
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
