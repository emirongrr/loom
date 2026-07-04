// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Hook} from "../../src/interfaces/IERC7579Hook.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";

/// @dev Standard ERC-7579 hook that records the preCheck arguments it observes,
/// keyed by `msg.sender` (the shim). Returns a context blob and asserts it is
/// handed back unchanged in postCheck, exercising the shim's context passthrough.
contract MockERC7579Hook is IERC7579Hook {
    mapping(address installer => bool) public installed;
    address public lastMsgSender;
    uint256 public lastMsgValue;
    bytes32 public lastMsgDataHash;
    uint256 public preChecks;
    uint256 public postChecks;

    function onInstall(bytes calldata) external {
        require(!installed[msg.sender], "already installed");
        installed[msg.sender] = true;
    }

    function onUninstall(bytes calldata) external {
        require(installed[msg.sender], "not installed");
        delete installed[msg.sender];
    }

    function isModuleType(uint256 typeID) external pure returns (bool) {
        return typeID == ModuleType.HOOK;
    }

    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData) external returns (bytes memory) {
        lastMsgSender = msgSender;
        lastMsgValue = msgValue;
        lastMsgDataHash = keccak256(msgData);
        ++preChecks;
        return abi.encode(keccak256(msgData));
    }

    function postCheck(bytes calldata hookData) external {
        require(abi.decode(hookData, (bytes32)) == lastMsgDataHash, "context tampered");
        ++postChecks;
    }
}
