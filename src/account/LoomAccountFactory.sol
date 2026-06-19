// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "./LoomAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

contract LoomAccountFactory {
    error InvalidFactory();

    IEntryPoint public immutable entryPoint;

    constructor(IEntryPoint entryPoint_) {
        if (address(entryPoint_).code.length == 0) revert InvalidFactory();
        if (address(entryPoint_.senderCreator()).code.length == 0) revert InvalidFactory();
        entryPoint = entryPoint_;
    }

    function createAccount(
        bytes32 salt,
        bytes32 guardianRoot,
        uint8 guardianThreshold,
        bytes32 configHash,
        LoomAccount.ModuleInit[] calldata modules
    ) external returns (LoomAccount account) {
        if (msg.sender != address(entryPoint.senderCreator())) revert InvalidFactory();
        address predicted = getAddress(salt, guardianRoot, guardianThreshold, configHash, modules);
        if (predicted.code.length != 0) return LoomAccount(payable(predicted));
        account = new LoomAccount{salt: salt}(address(entryPoint), guardianRoot, guardianThreshold, configHash, modules);
    }

    function getAddress(
        bytes32 salt,
        bytes32 guardianRoot,
        uint8 guardianThreshold,
        bytes32 configHash,
        LoomAccount.ModuleInit[] calldata modules
    ) public view returns (address) {
        bytes memory initCode = abi.encodePacked(
            type(LoomAccount).creationCode,
            abi.encode(address(entryPoint), guardianRoot, guardianThreshold, configHash, modules)
        );
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode)))))
            );
    }
}
