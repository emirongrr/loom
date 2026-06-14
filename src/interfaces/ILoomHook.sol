// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ILoomModule} from "./ILoomModule.sol";

interface ILoomHook is ILoomModule {
    function preCheck(address account, address caller, bytes calldata accountCall)
        external
        returns (bytes memory hookData);

    function postCheck(address account, bytes calldata hookData) external;
}
