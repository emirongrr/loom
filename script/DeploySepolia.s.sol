// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {AppAccountRegistry} from "../src/AppAccountRegistry.sol";
import {OnboardingPaymaster} from "../src/OnboardingPaymaster.sol";
import {LoomAccount} from "../src/LoomAccount.sol";
import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {ModuleType} from "../src/libraries/ModuleType.sol";
import {ECDSAValidator} from "../src/validators/ECDSAValidator.sol";
import {P256Validator} from "../src/validators/P256Validator.sol";
import {P256RecoveryValidatorFactory} from "../src/validators/P256RecoveryValidatorFactory.sol";
import {MultiP256Validator} from "../src/validators/MultiP256Validator.sol";
import {ExactCallSessionValidator} from "../src/validators/ExactCallSessionValidator.sol";
import {GranularSessionValidator} from "../src/validators/GranularSessionValidator.sol";
import {ImplementationLockValidator} from "../src/validators/ImplementationLockValidator.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {VaultHook} from "../src/hooks/VaultHook.sol";
import {RecoveryIntentBoard} from "../src/recovery/RecoveryIntentBoard.sol";
import {RecoveryManager} from "../src/recovery/RecoveryManager.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";
import {P256GuardianVerifier} from "../src/recovery/P256GuardianVerifier.sol";
import {ERC1271GuardianVerifier} from "../src/recovery/ERC1271GuardianVerifier.sol";
import {P256VerifierConfig, P256VerifierMode, P256VerifierSelection} from "./P256VerifierConfig.sol";

contract DeploySepolia is Script {
    uint256 private constant SEPOLIA_CHAIN_ID = 11_155_111;
    address private constant ENTRYPOINT_V0_9 = 0x433709009B8330FDa32311DF1C2AFA402eD8D009;
    bytes32 private constant ENTRYPOINT_V0_9_RUNTIME_CODEHASH =
        0x280d5c7c0de94b512401eb9c4b0ef0436275ff03627aad0ce1f93ab1627187a0;
    address private constant SENDER_CREATOR_V0_9 = 0x0A630a99Df908A81115A3022927Be82f9299987e;

    error InvalidSepoliaChain(uint256 actualChainId);
    error InvalidSepoliaEntryPoint(address actualEntryPoint);
    error InvalidDeploymentBinding();

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
        address p256RecoveryValidatorFactory,
        address multiP256Validator,
        address ecdsaValidator,
        address exactCallSessionValidator,
        address granularSessionValidator,
        address recoveryManager,
        address recoveryIntentBoard,
        address ecdsaGuardianVerifier,
        address p256GuardianVerifier,
        address erc1271GuardianVerifier,
        address onboardingPaymaster
    );

    function run() external returns (LoomAccountFactory factory) {
        if (block.chainid != SEPOLIA_CHAIN_ID) revert InvalidSepoliaChain(block.chainid);
        uint256 deployerKey = vm.envUint("SEPOLIA_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address entryPoint = vm.envAddress("SEPOLIA_ENTRYPOINT");
        if (entryPoint != ENTRYPOINT_V0_9) revert InvalidSepoliaEntryPoint(entryPoint);
        if (entryPoint.codehash != ENTRYPOINT_V0_9_RUNTIME_CODEHASH) revert InvalidSepoliaEntryPoint(entryPoint);
        if (
            address(IEntryPoint(entryPoint).senderCreator()) != SENDER_CREATOR_V0_9
                || SENDER_CREATOR_V0_9.code.length == 0
        ) revert InvalidSepoliaEntryPoint(entryPoint);

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
        P256RecoveryValidatorFactory p256RecoveryValidatorFactory = new P256RecoveryValidatorFactory(
            p256Selection.mode == P256VerifierMode.NativePrecompile ? address(0) : p256Selection.verifier
        );
        MultiP256Validator multiP256Validator = new MultiP256Validator(
            p256Selection.mode == P256VerifierMode.NativePrecompile ? address(0) : p256Selection.verifier
        );
        ExactCallSessionValidator exactCallSessionValidator = new ExactCallSessionValidator();
        GranularSessionValidator granularSessionValidator = new GranularSessionValidator();
        RecoveryManager recoveryManager = new RecoveryManager();
        // ADR-0024. Optional per deployment and never installed as a module, but a
        // deployment that omits it leaves guardian discovery permanently inert.
        RecoveryIntentBoard recoveryIntentBoard = new RecoveryIntentBoard();
        ECDSAGuardianVerifier ecdsaGuardianVerifier = new ECDSAGuardianVerifier();
        P256GuardianVerifier p256GuardianVerifier = new P256GuardianVerifier(
            p256Selection.mode == P256VerifierMode.NativePrecompile ? address(0) : p256Selection.verifier
        );
        ERC1271GuardianVerifier erc1271GuardianVerifier = new ERC1271GuardianVerifier();

        // Initialize the shared implementation so nobody can seize its initializer,
        // while granting neither the deployer nor any Loom-operated key authority at
        // the implementation address itself. Proxy accounts install their own live
        // validators and hooks in isolated proxy storage.
        ImplementationLockValidator implementationLockValidator = new ImplementationLockValidator();
        LoomAccount.ModuleInit[] memory implementationModules = new LoomAccount.ModuleInit[](1);
        implementationModules[0] =
            LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(implementationLockValidator), "");

        LoomAccount implementation = new LoomAccount(
            entryPoint,
            keccak256("loom.sepolia.implementation.guardian-root"),
            1,
            keccak256("loom.sepolia.implementation.config"),
            implementationModules
        );
        factory = new LoomAccountFactory(IEntryPoint(entryPoint), address(implementation));
        AppAccountRegistry appRegistry = factory.registry();
        OnboardingPaymaster onboardingPaymaster;
        if (vm.envOr("SEPOLIA_SPONSORED_ONBOARDING", false)) {
            address sponsorAuthorizer = vm.envAddress("SEPOLIA_SPONSOR_AUTHORIZER");
            bytes32 sponsorPolicyHash = vm.envBytes32("SEPOLIA_SPONSOR_POLICY_HASH");
            uint256 sponsorMaximumCost = vm.envUint("SEPOLIA_SPONSOR_MAX_COST_WEI");
            uint256 sponsorDeposit = vm.envUint("SEPOLIA_SPONSOR_DEPOSIT_WEI");
            if (sponsorDeposit == 0) revert InvalidDeploymentBinding();
            onboardingPaymaster = new OnboardingPaymaster(
                IEntryPoint(entryPoint), address(factory), sponsorAuthorizer, sponsorPolicyHash, sponsorMaximumCost
            );
            onboardingPaymaster.deposit{value: sponsorDeposit}();
        }
        if (
            address(factory.entryPoint()) != entryPoint || factory.accountImplementation() != address(implementation)
                || appRegistry.factory() != address(factory)
        ) revert InvalidDeploymentBinding();

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
            deployer,
            entryPoint,
            p256Selection.verifier,
            p256Selection.mode,
            p256Selection.codehash,
            address(implementation),
            address(factory),
            address(appRegistry),
            address(policyHook),
            address(vaultHook),
            address(p256Validator),
            address(p256RecoveryValidatorFactory),
            address(multiP256Validator),
            address(ecdsaValidator),
            address(exactCallSessionValidator),
            address(granularSessionValidator),
            address(recoveryManager),
            address(recoveryIntentBoard),
            address(ecdsaGuardianVerifier),
            address(p256GuardianVerifier),
            address(erc1271GuardianVerifier),
            address(onboardingPaymaster)
        );

        vm.stopBroadcast();
    }
}
