// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "./LoomAccount.sol";
import {AppAccountRegistry} from "../factory/AppAccountRegistry.sol";
import {LoomAccountProxy} from "../proxy/LoomAccountProxy.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

contract LoomAccountFactory {
    error InvalidFactory();

    IEntryPoint public immutable entryPoint;
    address public immutable accountImplementation;
    AppAccountRegistry public immutable registry;

    event LoomAccountCreated(address indexed account);

    constructor(IEntryPoint entryPoint_, address accountImplementation_) {
        if (address(entryPoint_).code.length == 0 || accountImplementation_.code.length == 0) revert InvalidFactory();
        if (address(entryPoint_.senderCreator()).code.length == 0) revert InvalidFactory();
        entryPoint = entryPoint_;
        accountImplementation = accountImplementation_;
        registry = new AppAccountRegistry(address(this));
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
        bytes memory initData = _initData(guardianRoot, guardianThreshold, configHash, modules);
        account = LoomAccount(payable(address(new LoomAccountProxy{salt: salt}(accountImplementation, initData))));
        registry.registerAccount(address(account));
        emit LoomAccountCreated(address(account));
    }

    function getAddress(
        bytes32 salt,
        bytes32 guardianRoot,
        uint8 guardianThreshold,
        bytes32 configHash,
        LoomAccount.ModuleInit[] calldata modules
    ) public view returns (address) {
        bytes memory initData = _initData(guardianRoot, guardianThreshold, configHash, modules);
        bytes memory initCode =
            abi.encodePacked(type(LoomAccountProxy).creationCode, abi.encode(accountImplementation, initData));
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode)))))
            );
    }

    /// @dev Single source for the account initializer calldata so createAccount and
    /// getAddress cannot diverge (a divergence would break counterfactual address prediction).
    function _initData(
        bytes32 guardianRoot,
        uint8 guardianThreshold,
        bytes32 configHash,
        LoomAccount.ModuleInit[] calldata modules
    ) private view returns (bytes memory) {
        return abi.encodeCall(
            LoomAccount.initialize, (address(entryPoint), guardianRoot, guardianThreshold, configHash, modules)
        );
    }
}
