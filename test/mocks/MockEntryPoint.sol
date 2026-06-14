// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/account/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/account/LoomAccountFactory.sol";

contract MockEntryPoint {
    function getNonce(address, uint192) external pure returns (uint256) {
        return 0;
    }

    function senderCreator() external view returns (address) {
        return address(this);
    }

    function createAccount(
        LoomAccountFactory factory,
        bytes32 salt,
        bytes32 guardianRoot,
        uint8 guardianThreshold,
        bytes32 configHash,
        LoomAccount.ModuleInit[] calldata modules
    ) external returns (LoomAccount) {
        return factory.createAccount(salt, guardianRoot, guardianThreshold, configHash, modules);
    }
}
