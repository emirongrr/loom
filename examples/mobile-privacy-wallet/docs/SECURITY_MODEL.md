# Security Model

## Keys

- The wallet key is a WebAuthn / P-256 **passkey**. The private key lives in the
  platform credential manager and secure hardware; the app never sees or stores
  it.
- Biometrics/PIN authorize *use* of the credential. They are not the key and are
  not a recovery mechanism.
- The passkey binds to a relying-party id and origin pinned in the native build
  policy. The JavaScript layer cannot expand that policy at runtime.

## What the passkey protects, and what it does not

- **Protects:** signing authority for UserOperations and direct execution on the
  account, gated by user verification.
- **Does not protect:** privacy (a passkey does not hide transactions),
  censorship resistance (a bundler can still refuse), recovery (a lost passkey
  needs guardians), or metadata (the bundler and RPC still observe activity).

## Account-level defense

Passkey validation is one validator on the Loom account, not unrestricted
authority. The account enforces policy hooks, timelocked configuration changes,
guardian recovery with no spending authority, and fail-closed rejection of
unsupported modes. Compromising the passkey does not grant the ability to remove
recovery instantly or bypass spend policy.

## Local storage rules

The app must never persist in plaintext, and should prefer hardware-backed
storage for anything sensitive:

- raw credential identifiers (only a credential-id hash is exposed),
- attestation objects,
- viewing keys or account-graph data,
- raw private-transaction metadata,
- session keys without scope and expiry.

Public configuration (chain id, addresses, provider URLs) is not secret and may
live in `EXPO_PUBLIC_` variables.

## Sessions

Session grants are bounded by target, selector, token, per-call and per-use
amounts, use count, expiry, and paymaster. The example never creates an
unlimited session. A compromised session is bounded until expiry and revocable.

## Evidence required before claiming security

This example is **not audited** and makes no production security claim. See
`GAPS.md` and `docs/PRODUCTION_CHECKLIST.md` for the evidence each claim needs.
