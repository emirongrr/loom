# Decision 0011: Validate P-256 Public Keys At Configuration

## Status

Accepted.

## Context

The shared WebAuthn key check rejected zero coordinates and missing relying-
party or origin commitments, but did not prove that `(x, y)` was a field-
bounded point on the P-256 curve. The native precompile and fallback verifier
only run when a signature is checked, after configuration has already become
account authority. An invalid configured key therefore fails closed but can
lock the user out.

This changes cryptographic verification and account availability, so it crosses
the engineering decision threshold.

## Decision

`WebAuthnP256.isValidKey` must validate coordinates with the pinned OpenZeppelin
`P256.isValidPublicKey` implementation in addition to requiring non-zero
relying-party and origin commitments. All consumers of the shared key check -
single-passkey initialization and rotation, multi-passkey credential changes,
and guardian verification - inherit the same curve membership rule.

Acceptance requires tests for zero coordinates, coordinates outside the field,
off-curve coordinates, valid initialization, and timelocked key rotation. The
configuration result is independent of whether a deployment later uses the
native precompile or its immutable fallback verifier.

## Consequences

Invalid points are rejected before they can become account authority. Existing
integrations that supplied placeholder coordinates to production configuration
will now fail immediately instead of creating an unusable account. Test-only
mock verifier fixtures must use real curve points so mocks cannot hide invalid
configuration.

The check adds bounded configuration-time gas and bytecode through a pure curve
equation check. It does not add a new verifier, external call, mutable trust
anchor, or upgrade authority.

## Rejected Alternatives

- Rely on the native precompile or fallback verifier during first signature
  validation: rejected because configuration would already have committed the
  invalid authority and verifier availability differs by chain.
- Probe the key by requiring a signature during configuration: rejected because
  it widens initialization ceremony and still delegates a deterministic curve
  property to deployment-specific verifier behavior.
- Document the lockout risk without rejecting invalid points: rejected because
  the curve equation can be checked deterministically and cheaply.

## Residual Risks

Curve membership does not prove that the user controls the corresponding
private key. Registration ceremony, relying-party binding, authenticator
quality, browser/device compatibility, and native/fallback verifier correctness
remain separate production requirements.
