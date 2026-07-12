// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LoomAccount} from "../../src/LoomAccount.sol";
import {LoomAccountFactory} from "../../src/LoomAccountFactory.sol";
import {LoomAccountProxy} from "../../src/LoomAccountProxy.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {ModuleType} from "../../src/libraries/ModuleType.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";
import {MockValidator} from "../mocks/MockValidator.sol";

// Solidity side of the Loom core (`@loom/core`) account-derivation differential.
// The SDK encodes LoomAccount.initialize and LoomAccountFactory.createAccount
// calldata and derives the CREATE2 proxy address off-chain.
// test/fixtures/account-derivation.json holds the inputs and the outputs the SDK
// produced; here we recompute the calldata with abi.encodeCall and the address
// with the CREATE2 keccak formula and assert byte-equality, so the SDK encoding
// and the contract signatures can never disagree unnoticed. A final test proves
// the composed formula itself matches the real factory's getAddress with the
// real proxy creation code, closing the composition link the fixture's dummy
// creation code cannot cover.
contract AccountDerivationDifferentialTest {
    VmDerivation internal constant vm = VmDerivation(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal json;

    function setUp() public {
        json = vm.readFile("test/fixtures/account-derivation.json");
    }

    function _modules() internal view returns (LoomAccount.ModuleInit[] memory modules) {
        modules = new LoomAccount.ModuleInit[](2);
        modules[0] = LoomAccount.ModuleInit(
            vm.parseJsonUint(json, ".inputs.modules[0].moduleTypeId"),
            vm.parseJsonAddress(json, ".inputs.modules[0].module"),
            vm.parseJsonBytes(json, ".inputs.modules[0].initData")
        );
        modules[1] = LoomAccount.ModuleInit(
            vm.parseJsonUint(json, ".inputs.modules[1].moduleTypeId"),
            vm.parseJsonAddress(json, ".inputs.modules[1].module"),
            vm.parseJsonBytes(json, ".inputs.modules[1].initData")
        );
    }

    function _initializeCalldata() internal view returns (bytes memory) {
        return abi.encodeCall(
            LoomAccount.initialize,
            (
                vm.parseJsonAddress(json, ".inputs.entryPoint"),
                vm.parseJsonBytes32(json, ".inputs.guardianRoot"),
                uint8(vm.parseJsonUint(json, ".inputs.guardianThreshold")),
                vm.parseJsonBytes32(json, ".inputs.configHash"),
                _modules()
            )
        );
    }

    function testInitializeCalldataMatches() public view {
        bytes memory expected = vm.parseJsonBytes(json, ".outputs.initializeCalldata");
        require(keccak256(_initializeCalldata()) == keccak256(expected), "initialize calldata != abi.encodeCall");
    }

    function testCreateAccountCalldataMatches() public view {
        bytes memory actual = abi.encodeCall(
            LoomAccountFactory.createAccount,
            (
                vm.parseJsonBytes32(json, ".inputs.salt"),
                vm.parseJsonBytes32(json, ".inputs.guardianRoot"),
                uint8(vm.parseJsonUint(json, ".inputs.guardianThreshold")),
                vm.parseJsonBytes32(json, ".inputs.configHash"),
                _modules()
            )
        );
        bytes memory expected = vm.parseJsonBytes(json, ".outputs.createAccountCalldata");
        require(keccak256(actual) == keccak256(expected), "createAccount calldata != abi.encodeCall");
    }

    function testDerivedAddressMatchesCreate2Formula() public view {
        address factory = vm.parseJsonAddress(json, ".inputs.factory");
        bytes32 salt = vm.parseJsonBytes32(json, ".inputs.salt");
        bytes memory creationCode = vm.parseJsonBytes(json, ".inputs.proxyCreationCode");
        bytes memory initCode = abi.encodePacked(
            creationCode, abi.encode(vm.parseJsonAddress(json, ".inputs.implementation"), _initializeCalldata())
        );
        address expected = vm.parseJsonAddress(json, ".outputs.derivedAddress");
        address actual =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, keccak256(initCode))))));
        require(actual == expected, "derived address != CREATE2 formula");

        bytes32 exampleHash = 0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a;
        address exampleActual =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, exampleHash)))));
        require(exampleActual == vm.parseJsonAddress(json, ".outputs.create2Example"), "create2 example mismatch");
    }

    /// @dev Closes the composition link: the formula the SDK implements
    /// (CREATE2 over proxyCreationCode ++ abi.encode(implementation, initData))
    /// must equal the real factory's getAddress with the real creation code.
    function testComposedFormulaMatchesRealFactory() public {
        MockEntryPoint entryPoint = new MockEntryPoint();
        MockValidator validator = new MockValidator();
        LoomAccount.ModuleInit[] memory implModules = new LoomAccount.ModuleInit[](1);
        implModules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        LoomAccount implementation = new LoomAccount(
            address(entryPoint),
            keccak256("implementation-guardians"),
            1,
            keccak256("implementation-config"),
            implModules
        );
        LoomAccountFactory factory = new LoomAccountFactory(IEntryPoint(address(entryPoint)), address(implementation));

        LoomAccount.ModuleInit[] memory modules = new LoomAccount.ModuleInit[](1);
        modules[0] = LoomAccount.ModuleInit(ModuleType.VALIDATOR, address(validator), "");
        bytes32 salt = keccak256("derivation-composition");
        bytes memory initData = abi.encodeCall(
            LoomAccount.initialize, (address(entryPoint), keccak256("guardians"), 1, keccak256("config"), modules)
        );
        bytes memory initCode =
            abi.encodePacked(type(LoomAccountProxy).creationCode, abi.encode(address(implementation), initData));
        address composed = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, keccak256(initCode)))))
        );

        require(
            composed == factory.getAddress(salt, keccak256("guardians"), 1, keccak256("config"), modules),
            "composed CREATE2 formula != factory.getAddress"
        );
    }
}

interface VmDerivation {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
}
