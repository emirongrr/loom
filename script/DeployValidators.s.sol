// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256Validator} from "../src/validators/P256Validator.sol";
import {MultiP256Validator} from "../src/validators/MultiP256Validator.sol";
import {ExactCallSessionValidator} from "../src/validators/ExactCallSessionValidator.sol";
import {GranularSessionValidator} from "../src/validators/GranularSessionValidator.sol";
import {RecoveryManager} from "../src/recovery/RecoveryManager.sol";
import {ECDSAGuardianVerifier} from "../src/recovery/ECDSAGuardianVerifier.sol";

contract DeployPasskeyValidators {
    function deploy(address p256FallbackVerifier)
        external
        returns (P256Validator p256Validator, MultiP256Validator multiP256Validator)
    {
        p256Validator = new P256Validator(p256FallbackVerifier);
        multiP256Validator = new MultiP256Validator(p256FallbackVerifier);
    }
}

contract DeployAuthorizationValidators {
    function deploy()
        external
        returns (ExactCallSessionValidator sessionKeyValidator, GranularSessionValidator granularSessionValidator)
    {
        sessionKeyValidator = new ExactCallSessionValidator();
        granularSessionValidator = new GranularSessionValidator();
    }
}

contract DeployRecoveryModules {
    function deploy() external returns (RecoveryManager recoveryManager, ECDSAGuardianVerifier guardianVerifier) {
        recoveryManager = new RecoveryManager();
        guardianVerifier = new ECDSAGuardianVerifier();
    }
}
