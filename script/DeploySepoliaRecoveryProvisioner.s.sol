// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";

import {P256Validator} from "../src/validators/P256Validator.sol";
import {P256RecoveryValidatorFactory} from "../src/validators/P256RecoveryValidatorFactory.sol";

/// @notice Adds recovery provisioning to an existing deployment without replacing its account factory or modules.
contract DeploySepoliaRecoveryProvisioner is Script {
    event SepoliaRecoveryProvisionerDeployment(
        address indexed deployer,
        address indexed existingP256Validator,
        address indexed recoveryValidatorFactory,
        address fallbackVerifier,
        bytes32 validatorInitCodeHash
    );

    function run() external returns (P256RecoveryValidatorFactory factory) {
        uint256 deployerKey = vm.envUint("SEPOLIA_DEPLOYER_PRIVATE_KEY");
        address existingValidator = vm.envAddress("SEPOLIA_EXISTING_P256_VALIDATOR");
        if (existingValidator.code.length == 0) revert("SEPOLIA_EXISTING_P256_VALIDATOR has no code");

        address fallbackVerifier = P256Validator(existingValidator).fallbackVerifier();
        if (fallbackVerifier != address(0) && fallbackVerifier.code.length == 0) {
            revert("existing P256 fallback verifier has no code");
        }

        vm.startBroadcast(deployerKey);
        factory = new P256RecoveryValidatorFactory(fallbackVerifier);
        emit SepoliaRecoveryProvisionerDeployment(
            msg.sender, existingValidator, address(factory), fallbackVerifier, factory.validatorInitCodeHash()
        );
        vm.stopBroadcast();
    }
}
