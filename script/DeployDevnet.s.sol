// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {LoomAccount} from "../src/LoomAccount.sol";
import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../src/validators/ECDSAValidator.sol";
import {P256Validator} from "../src/validators/P256Validator.sol";
import {ExactCallSessionValidator} from "../src/validators/ExactCallSessionValidator.sol";
import {GranularSessionValidator} from "../src/validators/GranularSessionValidator.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {VaultHook} from "../src/hooks/VaultHook.sol";
import {RecoveryManager} from "../src/recovery/RecoveryManager.sol";

/// A trivial call target for the lifecycle test to write to and read back,
/// proving that an account-authorized UserOperation actually executed.
contract DevnetTarget {
    uint256 public value;

    function setValue(uint256 newValue) external payable {
        value = newValue;
    }
}

/// Devnet deployment for the hermetic end-to-end lifecycle test.
///
/// Deploys the full Loom stack plus a fresh EntryPoint to a local anvil node.
/// The P-256 verifier runs in native-precompile mode: the E2E orchestrator
/// probes the live node's EIP-7951 precompile (0x100) with a signed test
/// vector before this script runs, so native mode here is evidence-backed for
/// the devnet exactly as the production path requires for Sepolia/mainnet.
contract DeployDevnet is Script {
    event DevnetDeployment(
        address entryPoint,
        address accountImplementation,
        address accountFactory,
        address appRegistry,
        address policyHook,
        address vaultHook,
        address p256Validator,
        address ecdsaValidator,
        address exactCallSessionValidator,
        address granularSessionValidator,
        address recoveryManager,
        address target
    );

    function run() external returns (LoomAccountFactory factory) {
        uint256 deployerKey = vm.envUint("DEVNET_DEPLOYER_PRIVATE_KEY");

        // Devnet-only: the CLI pre-deploys the EntryPoint at a version-prefixed
        // CREATE2 address (bundlers detect the EntryPoint version from the
        // address prefix) and passes it here; without the override a fresh
        // EntryPoint is deployed as before.
        address entryPointOverride = vm.envOr("DEVNET_ENTRYPOINT", address(0));

        vm.startBroadcast(deployerKey);

        EntryPoint entryPoint =
            entryPointOverride == address(0) ? new EntryPoint() : EntryPoint(payable(entryPointOverride));
        PolicyHook policyHook = new PolicyHook();
        VaultHook vaultHook = new VaultHook();
        ECDSAValidator ecdsaValidator = new ECDSAValidator();
        // Native precompile mode: no fallback verifier contract.
        P256Validator p256Validator = new P256Validator(address(0));
        ExactCallSessionValidator exactCallSessionValidator = new ExactCallSessionValidator();
        GranularSessionValidator granularSessionValidator = new GranularSessionValidator();
        RecoveryManager recoveryManager = new RecoveryManager();
        DevnetTarget target = new DevnetTarget();

        LoomAccount.ModuleInit[] memory implementationModules = new LoomAccount.ModuleInit[](2);
        implementationModules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(policyHook), "");
        implementationModules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(ecdsaValidator),
            abi.encodeCall(ECDSAValidator.initialize, (msg.sender, address(policyHook)))
        );

        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("loom.devnet.implementation.guardian-root"),
            1,
            keccak256("loom.devnet.implementation.config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));

        emit DevnetDeployment(
            address(entryPoint),
            address(implementation),
            address(factory),
            address(factory.registry()),
            address(policyHook),
            address(vaultHook),
            address(p256Validator),
            address(ecdsaValidator),
            address(exactCallSessionValidator),
            address(granularSessionValidator),
            address(recoveryManager),
            address(target)
        );

        vm.stopBroadcast();
    }
}
