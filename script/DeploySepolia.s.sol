// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {AppAccountRegistry} from "../src/AppAccountRegistry.sol";
import {LoomAccount} from "../src/LoomAccount.sol";
import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../src/validators/ECDSAValidator.sol";
import {P256Validator} from "../src/validators/P256Validator.sol";
import {MultiP256Validator} from "../src/validators/MultiP256Validator.sol";
import {ExactCallSessionValidator} from "../src/validators/ExactCallSessionValidator.sol";
import {GranularSessionValidator} from "../src/validators/GranularSessionValidator.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {VaultHook} from "../src/hooks/VaultHook.sol";
import {RecoveryManager} from "../src/recovery/RecoveryManager.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {P256GuardianVerifier} from "../src/recovery/P256GuardianVerifier.sol";
import {ERC1271GuardianVerifier} from "../src/recovery/ERC1271GuardianVerifier.sol";
import {P256VerifierConfig, P256VerifierMode, P256VerifierSelection} from "./P256VerifierConfig.sol";

contract DeploySepolia is Script {
    event P256VerifierSelected(
        uint256 indexed chainId,
        address indexed verifier,
        P256VerifierMode mode,
        bytes32 codehash,
        bool nativePrecompileSupported,
        bool fallbackVerifierWasDeployed,
        bool fallbackVerifierWasProvided
    );

    event SepoliaDeployment(
        address indexed deployer,
        address entryPoint,
        address p256Verifier,
        P256VerifierMode p256VerifierMode,
        bytes32 p256VerifierCodehash,
        address accountImplementation,
        address accountFactory,
        address appRegistry,
        address policyHook,
        address vaultHook,
        address p256Validator,
        address multiP256Validator,
        address ecdsaValidator,
        address exactCallSessionValidator,
        address granularSessionValidator,
        address recoveryManager,
        address ecdsaGuardianVerifier,
        address p256GuardianVerifier,
        address erc1271GuardianVerifier
    );

    function run() external returns (LoomAccountFactory factory) {
        uint256 deployerKey = vm.envUint("SEPOLIA_DEPLOYER_PRIVATE_KEY");
        address entryPoint = vm.envAddress("SEPOLIA_ENTRYPOINT");
        if (entryPoint.code.length == 0) revert("SEPOLIA_ENTRYPOINT has no code");

        P256VerifierSelection memory p256Selection = P256VerifierConfig.select(
            block.chainid,
            vm.envOr("SEPOLIA_P256_FALLBACK_VERIFIER", address(0)),
            vm.envOr("SEPOLIA_P256_FALLBACK_CODEHASH", bytes32(0))
        );

        vm.startBroadcast(deployerKey);

        PolicyHook policyHook = new PolicyHook();
        VaultHook vaultHook = new VaultHook();
        ECDSAValidator ecdsaValidator = new ECDSAValidator();
        P256Validator p256Validator = new P256Validator(
            p256Selection.mode == P256VerifierMode.NativePrecompile ? address(0) : p256Selection.verifier
        );
        MultiP256Validator multiP256Validator = new MultiP256Validator(
            p256Selection.mode == P256VerifierMode.NativePrecompile ? address(0) : p256Selection.verifier
        );
        ExactCallSessionValidator exactCallSessionValidator = new ExactCallSessionValidator();
        GranularSessionValidator granularSessionValidator = new GranularSessionValidator();
        RecoveryManager recoveryManager = new RecoveryManager();
        ECDSAGuardianVerifier ecdsaGuardianVerifier = new ECDSAGuardianVerifier();
        P256GuardianVerifier p256GuardianVerifier = new P256GuardianVerifier(
            p256Selection.mode == P256VerifierMode.NativePrecompile ? address(0) : p256Selection.verifier
        );
        ERC1271GuardianVerifier erc1271GuardianVerifier = new ERC1271GuardianVerifier();

        LoomAccount.ModuleInit[] memory implementationModules = new LoomAccount.ModuleInit[](2);
        implementationModules[0] = LoomAccount.ModuleInit(ModuleType.HOOK, address(policyHook), "");
        implementationModules[1] = LoomAccount.ModuleInit(
            ModuleType.VALIDATOR,
            address(ecdsaValidator),
            abi.encodeCall(ECDSAValidator.initialize, (msg.sender, address(policyHook)))
        );

        LoomAccount implementation = new LoomAccount(
            entryPoint,
            keccak256("loom.sepolia.implementation.guardian-root"),
            1,
            keccak256("loom.sepolia.implementation.config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(entryPoint), address(implementation));

        emit P256VerifierSelected(
            block.chainid,
            p256Selection.verifier,
            p256Selection.mode,
            p256Selection.codehash,
            p256Selection.nativePrecompileSupported,
            p256Selection.fallbackVerifierWasDeployed,
            p256Selection.fallbackVerifierWasProvided
        );

        emit SepoliaDeployment(
            msg.sender,
            entryPoint,
            p256Selection.verifier,
            p256Selection.mode,
            p256Selection.codehash,
            address(implementation),
            address(factory),
            address(factory.registry()),
            address(policyHook),
            address(vaultHook),
            address(p256Validator),
            address(multiP256Validator),
            address(ecdsaValidator),
            address(exactCallSessionValidator),
            address(granularSessionValidator),
            address(recoveryManager),
            address(ecdsaGuardianVerifier),
            address(p256GuardianVerifier),
            address(erc1271GuardianVerifier)
        );

        vm.stopBroadcast();
    }
}
