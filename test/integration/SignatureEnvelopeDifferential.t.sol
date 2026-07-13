// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {P256Validator} from "../../src/validators/P256Validator.sol";

// Solidity side of the Loom core (`@loom/core`) signature-envelope differential.
// The SDK encodes the account-level `(validator, validatorSignature)` envelope
// and the WebAuthnSignature struct off-chain.
// test/fixtures/signature-envelope.json holds the inputs and the bytes the SDK
// produced; here we decode them with the exact abi.decode calls LoomAccount
// (envelope split) and P256Validator (struct decode) perform and assert every
// field round-trips, so the SDK encoding and the on-chain decoders can never
// disagree unnoticed. Low-s normalization is asserted against the fixture's
// deliberately high-s raw input.
contract SignatureEnvelopeDifferentialTest {
    VmSignature internal constant vm = VmSignature(address(uint160(uint256(keccak256("hevm cheat code")))));

    // The P-256 group order WebAuthnP256 enforces; the fixture's raw s is n - 7.
    uint256 internal constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    string internal json;

    function setUp() public {
        json = vm.readFile("test/fixtures/signature-envelope.json");
    }

    function testEnvelopeDecodesToValidatorAndWebAuthnStruct() public view {
        bytes memory envelope = vm.parseJsonBytes(json, ".outputs.envelope");
        (address validator, bytes memory validatorSignature) = abi.decode(envelope, (address, bytes));

        require(validator == vm.parseJsonAddress(json, ".inputs.validator"), "validator mismatch");
        require(
            keccak256(validatorSignature) == keccak256(vm.parseJsonBytes(json, ".outputs.webAuthnSignature")),
            "validator signature bytes mismatch"
        );

        P256Validator.WebAuthnSignature memory webAuthn =
            abi.decode(validatorSignature, (P256Validator.WebAuthnSignature));
        require(
            keccak256(webAuthn.authenticatorData) == keccak256(vm.parseJsonBytes(json, ".inputs.authenticatorData")),
            "authenticatorData mismatch"
        );
        require(
            keccak256(webAuthn.clientDataJSON) == keccak256(vm.parseJsonBytes(json, ".inputs.clientDataJSON")),
            "clientDataJSON mismatch"
        );
        require(keccak256(webAuthn.origin) == keccak256(bytes("https://wallet.example")), "origin mismatch");
        require(webAuthn.r == vm.parseJsonBytes32(json, ".outputs.r"), "r mismatch");
        require(webAuthn.s == vm.parseJsonBytes32(json, ".outputs.s"), "s mismatch");
    }

    function testLowSNormalizationMatchesTheCurveOrder() public view {
        // The fixture's raw signature carries s = n - 7; the SDK must have
        // normalized it to 7 and kept r untouched.
        require(uint256(vm.parseJsonBytes32(json, ".outputs.r")) == 5, "r changed by normalization");
        require(uint256(vm.parseJsonBytes32(json, ".outputs.s")) == 7, "s not normalized to low-s");
        require(uint256(vm.parseJsonBytes32(json, ".outputs.s")) <= P256_N / 2, "s above half order");
    }
}

interface VmSignature {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
}
