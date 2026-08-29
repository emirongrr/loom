// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {ImplementationLockValidator} from "../../src/validators/ImplementationLockValidator.sol";
import {LoomAccount} from "../../src/LoomAccount.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {ValidationDataLib} from "../../src/libraries/ValidationDataLib.sol";

contract ImplementationLockValidatorTest is Test {
    ImplementationLockValidator internal validator;

    function setUp() external {
        validator = new ImplementationLockValidator();
    }

    function testNeverAcceptsAccountAuthority() external {
        assertTrue(validator.isModuleType(ModuleType.VALIDATOR));
        assertFalse(validator.isModuleType(ModuleType.HOOK));
        assertFalse(validator.isValidSignature(address(this), bytes32(uint256(1)), hex"1234"));
        assertEq(
            validator.validateUserOp(
                address(this), bytes32(uint256(1)), 0, hex"1234", hex"abcdef", address(0xBEEF)
            ),
            ValidationDataLib.SIG_VALIDATION_FAILED
        );
    }

    function testInitializedImplementationCannotValidateOrBeReinitialized() external {
        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount implementation =
            new LoomAccount(address(this), keccak256("locked-guardians"), 1, keccak256("locked-config"), modules);

        bytes memory envelope = abi.encode(address(validator), hex"1234");
        assertEq(implementation.isValidSignature(bytes32(uint256(1)), envelope), bytes4(0xffffffff));
        vm.expectRevert(LoomAccount.InvalidInitializationContext.selector);
        implementation.initialize(address(this), bytes32(0), 0, keccak256("replacement"), modules);
    }
}
