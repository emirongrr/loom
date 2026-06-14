// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/account/LoomAccount.sol";
import {IGuardianVerifier} from "../../src/interfaces/IGuardianVerifier.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmFormal {
    function warp(uint256) external;
}

contract FormalTarget {
    uint256 public value;

    function setValue(uint256 newValue) external {
        value = newValue;
    }

    function fail() external pure {
        revert("FAIL");
    }
}

contract FormalGuardianVerifier is IGuardianVerifier {
    function verify(bytes32, bytes32, bytes calldata) external pure returns (bool) {
        return true;
    }
}

abstract contract FormalAccountBase {
    VmFormal internal constant vm = VmFormal(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _account() internal returns (LoomAccount account, MockValidator validator) {
        validator = new MockValidator();
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        account = new LoomAccount(address(this), keccak256("guardians"), 1, keccak256("config"), modules);
    }
}
