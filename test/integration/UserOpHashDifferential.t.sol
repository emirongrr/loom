// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "account-abstraction/core/UserOperationLib.sol";

// Solidity side of the Loom core (`@loom/core`) user-operation hash
// differential. The SDK computes the ERC-4337 v0.9 struct hash and EIP-712
// user-operation hash off-chain. test/fixtures/userop-hash.json holds the packed
// operations and the hashes it produced; here we recompute the struct hash with
// the real account-abstraction UserOperationLib and rebuild the EIP-712 wrapper,
// then assert byte-equality. If UserOperationLib or the domain changes, this test
// fails until the SDK (and the fixture) are updated, so the SDK hashing and the
// EntryPoint can never disagree unnoticed.
contract UserOpHashDifferentialTest {
    using UserOperationLib for PackedUserOperation;

    VmUserOpHash internal constant vm = VmUserOpHash(address(uint160(uint256(keccak256("hevm cheat code")))));

    // EntryPoint v0.9 EIP-712 domain (DOMAIN_NAME "ERC4337", DOMAIN_VERSION "1").
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    string internal json;

    function setUp() public {
        json = vm.readFile("test/fixtures/userop-hash.json");
    }

    /// @dev Routes a memory operation into calldata so UserOperationLib (which
    /// takes `calldata`) can hash it exactly as the EntryPoint does.
    function refStructHash(PackedUserOperation calldata op) external pure returns (bytes32) {
        return op.hash(bytes32(0));
    }

    function _field(string memory name, string memory field) internal pure returns (string memory) {
        return string.concat(".cases.", name, ".", field);
    }

    function _op(string memory name) internal view returns (PackedUserOperation memory op) {
        string memory p = string.concat(".cases.", name, ".op.");
        op.sender = vm.parseJsonAddress(json, string.concat(p, "sender"));
        op.nonce = vm.parseJsonUint(json, string.concat(p, "nonce"));
        op.initCode = vm.parseJsonBytes(json, string.concat(p, "initCode"));
        op.callData = vm.parseJsonBytes(json, string.concat(p, "callData"));
        op.accountGasLimits = vm.parseJsonBytes32(json, string.concat(p, "accountGasLimits"));
        op.preVerificationGas = vm.parseJsonUint(json, string.concat(p, "preVerificationGas"));
        op.gasFees = vm.parseJsonBytes32(json, string.concat(p, "gasFees"));
        op.paymasterAndData = vm.parseJsonBytes(json, string.concat(p, "paymasterAndData"));
        op.signature = vm.parseJsonBytes(json, string.concat(p, "signature"));
    }

    function _check(string memory name) internal view {
        PackedUserOperation memory op = _op(name);
        bytes32 expectedStruct = vm.parseJsonBytes32(json, _field(name, "structHash"));
        bytes32 expectedUserOp = vm.parseJsonBytes32(json, _field(name, "userOpHash"));
        address entryPoint = vm.parseJsonAddress(json, _field(name, "entryPoint"));
        uint256 chainId = vm.parseJsonUint(json, _field(name, "chainId"));

        bytes32 structHash = this.refStructHash(op);
        require(structHash == expectedStruct, string.concat(name, ": struct hash != UserOperationLib.hash"));

        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ERC4337"), keccak256("1"), chainId, entryPoint));
        bytes32 userOpHash = keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator, structHash));
        require(userOpHash == expectedUserOp, string.concat(name, ": userOpHash != eip712(domain, structHash)"));
    }

    function testMinimalUserOpHashMatches() public view {
        _check("minimal");
    }

    function testFullUserOpHashMatches() public view {
        _check("full");
    }
}

interface VmUserOpHash {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
}
