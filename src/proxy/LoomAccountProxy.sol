// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

contract LoomAccountProxy {
    error InvalidProxy();
    error InitializationFailed(bytes returnData);

    address public immutable implementation;

    constructor(address implementation_, bytes memory initData) payable {
        if (implementation_.code.length == 0 || initData.length == 0) revert InvalidProxy();
        implementation = implementation_;
        (bool ok, bytes memory result) = implementation_.delegatecall(initData);
        if (!ok) revert InitializationFailed(result);
    }

    fallback() external payable {
        _delegate();
    }

    receive() external payable {
        _delegate();
    }

    function _delegate() internal {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
