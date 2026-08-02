// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {P256RecoveryValidatorFactory} from "../src/validators/P256RecoveryValidatorFactory.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

contract DeployCore {
    function deploy(IEntryPoint entryPoint, address accountImplementation, address p256FallbackVerifier)
        external
        returns (
            LoomAccountFactory factory,
            PolicyHook policyHook,
            P256RecoveryValidatorFactory recoveryValidatorFactory
        )
    {
        factory = new LoomAccountFactory(entryPoint, accountImplementation);
        policyHook = new PolicyHook();
        recoveryValidatorFactory = new P256RecoveryValidatorFactory(p256FallbackVerifier);
    }
}
