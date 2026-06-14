// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

contract MockPaymaster is IPaymaster {
    error OnlyEntryPoint();

    IEntryPoint public immutable entryPoint;
    uint256 public validations;
    uint256 public postOps;

    constructor(IEntryPoint entryPoint_) {
        entryPoint = entryPoint_;
    }

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        ++validations;
        return (abi.encode(address(this)), 0);
    }

    function postOp(PostOpMode, bytes calldata context, uint256, uint256) external {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        require(abi.decode(context, (address)) == address(this), "wrong context");
        ++postOps;
    }
}
