// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {GuardianVerificationLib} from "../../src/libraries/GuardianVerificationLib.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {PolicyHook} from "../../src/hooks/PolicyHook.sol";
import {ECDSAValidator} from "../../src/validators/ECDSAValidator.sol";
import {ECDSAGuardianVerifier} from "../../src/recovery/ECDSAGuardianVerifier.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

interface VmDep {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract MalformedPolicyValidator {
    uint256 private immutable _mode;
    address private immutable _dependency;

    constructor(uint256 mode, address dependency) {
        _mode = mode;
        _dependency = dependency;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }

    fallback() external {
        uint256 mode = _mode;
        address dependency = _dependency;
        assembly {
            switch mode
            case 0 { revert(0, 0) }
            case 1 {
                mstore(0, dependency)
                return(1, 31)
            }
            case 2 {
                mstore(0, shl(160, 1))
                return(0, 32)
            }
            case 3 {
                mstore(0, dependency)
                return(0, 64)
            }
            default { for {} 1 {} {} }
        }
    }
}

contract RevertingRebindValidator {
    address private immutable _dependency;

    constructor(address dependency) {
        _dependency = dependency;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.VALIDATOR;
    }

    function policyHookFor(address) external view returns (address) {
        return _dependency;
    }

    function rebindPolicyHook(address) external pure {
        revert("rebind refused");
    }
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
/// @notice Minimal stand-in for an installed recovery module, so the recovery
/// path can be driven without pulling in the whole `RecoveryManager` flow.
contract RecoveryModuleStub {
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == ModuleType.RECOVERY;
    }

    function recover(
        LoomAccount account,
        address[] calldata oldValidators,
        address newValidator,
        bytes calldata initData,
        bytes32 newGuardianRoot,
        uint8 newGuardianThreshold
    ) external {
        account.recoverConfiguration(oldValidators, newValidator, initData, newGuardianRoot, newGuardianThreshold);
    }
}

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
        // Install the hook first so the baseline account starts coherent.
        modules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(hook), "");
        modules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR, address(validator), abi.encodeCall(ECDSAValidator.initialize, (owner, address(hook)))
        );
        // This test contract stands in for the EntryPoint.
        account = new LoomAccount(address(this), guardianLeaf, 1, keccak256("config"), modules);
    }

    function testAccountValidatesWhileTheBoundHookIsInstalled() public {
        require(account.validateUserOp(_signedUserOp(address(validator)), _opHash(), 0) == 0, "baseline validation");
        require(validator.policyHookFor(address(account)) == address(hook), "dependency not reported");
    }

    /// @dev Recovery must remain able to install a validator whose declared hook
    /// is absent. It is the last-resort path and refusing it would leave whatever
    /// validator the guardians are replacing in place.
    /// A recovery that installs a validator naming an absent hook produces one
    /// that fails closed, and a further recovery can repair that; a blocked
    /// recovery cannot be repaired at all.
    function testRecoveryMayInstallAValidatorWhoseHookIsAbsent() public {
        PolicyHook absent = new PolicyHook();
        ECDSAValidator recovered = new ECDSAValidator();
        bytes memory initData = abi.encodeCall(ECDSAValidator.initialize, (owner, address(absent)));

        RecoveryModuleStub recovery = new RecoveryModuleStub();
        bytes memory install = abi.encodeCall(LoomAccount.installModule, (ModuleType.RECOVERY, address(recovery), ""));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(account), 0, install, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(account), 0, install);

        address[] memory oldValidators = new address[](1);
        oldValidators[0] = address(validator);
        recovery.recover(account, oldValidators, address(recovered), initData, keccak256("rotated-guardian-root"), 1);

        require(account.isModuleInstalled(ModuleType.VALIDATOR, address(recovered)), "recovery was refused");
        require(!account.isModuleInstalled(ModuleType.VALIDATOR, address(validator)), "old validator survived");
        require(!account.isModuleInstalled(ModuleType.HOOK, address(absent)), "absent hook was installed");
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
            keccak256(revertData) == keccak256(abi.encodeWithSelector(LoomAccount.InvalidModule.selector)),
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
        bytes32 configBefore = account.configHash();

        bytes32 digest = account.evictHookDigest(address(hook), address(replacement), account.configVersion());
        account.evictHookWithGuardians(address(hook), address(replacement), _guardianApprovals(digest));

        require(!account.isModuleInstalled(ModuleType.HOOK, address(hook)), "stuck hook not evicted");
        require(account.isModuleInstalled(ModuleType.HOOK, address(replacement)), "replacement not installed");
        require(
            validator.policyHookFor(address(account)) == address(replacement),
            "validator not rebound onto the replacement"
        );
        require(account.configVersion() == versionBefore + 1, "eviction did not advance config");
        require(account.configHash() == keccak256(abi.encode(configBefore, digest)), "config omitted approved eviction");
        require(!account.isExecutingScheduled(), "configuration context left active");

        // The account is still usable, which is the whole point.
        require(
            account.validateUserOp(_signedUserOp(address(validator)), _opHash(), 0) == 0,
            "account unusable after a hook swap"
        );
    }

    function testGuardianSwapRollsBackWhenRebindFails() public {
        RevertingRebindValidator refusing = new RevertingRebindValidator(address(hook));
        _scheduleAndRun(abi.encodeCall(LoomAccount.installModule, (ModuleType.VALIDATOR, address(refusing), "")));
        PolicyHook replacement = new PolicyHook();
        uint64 versionBefore = account.configVersion();
        bytes32 digest = account.evictHookDigest(address(hook), address(replacement), versionBefore);

        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    LoomAccount.evictHookWithGuardians,
                    (address(hook), address(replacement), _guardianApprovals(digest))
                )
            );

        require(!ok, "guardian swap ignored a failed rebind");
        require(account.isModuleInstalled(ModuleType.HOOK, address(hook)), "old hook removal was not rolled back");
        require(!account.isModuleInstalled(ModuleType.HOOK, address(replacement)), "replacement installation survived");
        require(validator.policyHookFor(address(account)) == address(hook), "earlier rebind was not rolled back");
        require(account.configVersion() == versionBefore, "failed swap advanced configuration");
        require(!account.isExecutingScheduled(), "failed swap left configuration context active");
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

    /// @notice Optional dependency discovery cannot give a malformed validator a
    /// veto over hook removal or trick the account into decoding a dirty address.
    function testMalformedDependencyResponsesDoNotVetoUnrelatedHookRemoval() public {
        PolicyHook spare = new PolicyHook();
        _scheduleAndRun(abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(spare), "")));

        for (uint256 mode; mode < 5; ++mode) {
            MalformedPolicyValidator malformed = new MalformedPolicyValidator(mode, address(spare));
            _scheduleAndRun(abi.encodeCall(LoomAccount.installModule, (ModuleType.VALIDATOR, address(malformed), "")));
        }

        _scheduleAndRun(abi.encodeCall(LoomAccount.uninstallModule, (ModuleType.HOOK, address(spare), "")));
        require(!account.isModuleInstalled(ModuleType.HOOK, address(spare)), "malformed response vetoed removal");
    }

    /// @notice Rebinding is rejected outside a scheduled configuration or the
    /// guardian eviction's atomic configuration section.
    function testRebindPolicyHookIsRejectedOutsideAConfigurationContext() public {
        PolicyHook other = new PolicyHook();
        _scheduleAndRun(abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(other), "")));
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
        require(!viaAccount, "untimelocked rebind accepted");
        require(validator.policyHookFor(address(account)) == address(hook), "dependency changed");
    }

    function testRebindPolicyHookIsAllowedThroughTheConfigurationTimelock() public {
        PolicyHook other = new PolicyHook();
        _scheduleAndRun(abi.encodeCall(LoomAccount.installModule, (ModuleType.HOOK, address(other), "")));

        bytes memory rebind = abi.encodeCall(ECDSAValidator.rebindPolicyHook, (address(other)));
        bytes memory schedule =
            abi.encodeCall(LoomAccount.scheduleCall, (address(validator), 0, rebind, account.MIN_CONFIG_DELAY()));
        account.execute(bytes32(0), abi.encode(ExecutionLib.Execution(address(account), 0, schedule)));
        vm.warp(block.timestamp + account.MIN_CONFIG_DELAY());
        account.executeScheduled(address(validator), 0, rebind);

        require(validator.policyHookFor(address(account)) == address(other), "scheduled rebind failed");
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
