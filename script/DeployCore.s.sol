// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccountFactory} from "../src/LoomAccountFactory.sol";
import {PolicyHook} from "../src/hooks/PolicyHook.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

contract DeployCore {
    function deploy(IEntryPoint entryPoint, address accountImplementation)
        external
        returns (LoomAccountFactory factory, PolicyHook policyHook)
    {
        factory = new LoomAccountFactory(entryPoint, accountImplementation);
        policyHook = new PolicyHook();
    }
}
