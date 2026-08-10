// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IP256Verifier} from "../../src/interfaces/IP256Verifier.sol";

/// @notice Reports every signature as valid.
/// @dev This proves nothing about P-256 verification and must never be used to
/// support a claim that a signature was checked. It exists so tests can isolate
/// the parts of the WebAuthn path that sit *around* the curve operation -
/// clientDataJSON grammar, challenge and origin binding, rpIdHash, the
/// user-presence and user-verification flags, low-s enforcement, credential
/// state, policy hooks, and timelocks - all of which `P256Validator` and
/// `WebAuthnP256` enforce before or after the verifier is consulted.
///
/// The real curve behaviour is proven elsewhere, against real implementations
/// and real browser-produced assertions:
/// - `test/evidence/WebAuthnFixtureCorpus.t.sol` runs recorded fixtures through
///   `OZP256Verifier` and asserts a one-bit mutation of `r` is rejected;
/// - `test/integration/P256VerifierParity.t.sol` asserts the precompile path and
///   the fallback path accept and reject the same assertions.
///
/// A test that installs this verifier must not name or describe its assertion
/// as being about the signature. See docs/security/test-doubles.md.
contract MockP256Verifier is IP256Verifier {
    function verifySignatureAllowMalleability(bytes32, uint256, uint256, uint256, uint256)
        external
        pure
        returns (bool)
    {
        return true;
    }
}
