// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {IGuardianVerifier} from "../../src/interfaces/IGuardianVerifier.sol";
import {ExecutionLib} from "../../src/libraries/ExecutionLib.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

interface VmFormal {
    function warp(uint256) external;
    function prank(address) external;
    function etch(address, bytes calldata) external;
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

contract FormalEntryPoint {
    function senderCreator() external pure returns (address) {
        return address(0x4337);
    }
}

contract FormalGuardianVerifier is IGuardianVerifier {
    function verify(bytes32, bytes32, bytes calldata) external pure returns (bool) {
        return true;
    }
}

abstract contract FormalAccountBase {
    VmFormal internal constant vm = VmFormal(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _validatorModules(MockValidator validator)
        internal
        pure
        returns (LoomAccount.ModuleInit[] memory modules)
    {
        modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
    }

    function _entryPointAddress() internal returns (address entryPoint) {
        entryPoint = address(0x4337);
        vm.etch(entryPoint, hex"60006000fd");
    }

    function _account() internal returns (LoomAccount account, MockValidator validator) {
        validator = new MockValidator();
        account = new LoomAccount(
            _entryPointAddress(), keccak256("guardians"), 1, keccak256("config"), _validatorModules(validator)
        );
    }

    function _unprotectedAccount() internal returns (LoomAccount account, MockValidator validator) {
        validator = new MockValidator();
        account =
            new LoomAccount(_entryPointAddress(), bytes32(0), 0, keccak256("config"), _validatorModules(validator));
    }

    function _executeFromEntryPoint(LoomAccount account, ExecutionLib.Execution memory execution) internal {
        vm.prank(account.entryPoint());
        account.execute(bytes32(0), abi.encode(execution));
    }

    function _guardianLeaf(FormalGuardianVerifier verifier, bytes32 keyCommitment, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(verifier), address(verifier).codehash, keyCommitment, salt));
    }
}
