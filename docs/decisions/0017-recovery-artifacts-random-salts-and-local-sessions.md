# 0017: Recovery artifacts, random salts, and local sessions

- Status: Accepted
- Date: 2026-07-28

## Context

Recovery commonly begins after the owner's passkey is lost or unavailable. Guardian Merkle salts derived from that passkey therefore make the recovery inventory depend on the credential being recovered. They also let a party that compromises the passkey test likely guardian identities against the public root.

Recovery coordination must also survive without a Loom-operated service. Request and response files are untrusted transport artifacts, while approval validity and readiness remain properties of live chain state.

## Decision

- Every new or rotated guardian epoch uses an independent cryptographically random salt for every guardian.
- Existing PRF-derived roots and local records remain unchanged and readable. They are never silently recomputed or migrated into a different root.
- WebAuthn PRF may protect or wrap local vault keys, but it is not a guardian-leaf input.
- A version 2 individualized guardian capability binds one guardian to both the current and scheduled standby epochs. Version 1 remains readable and is classified as current-only rather than being given a fabricated standby epoch.
- Recovery request and response artifacts are canonical, versioned, bounded, expiry-limited, integrity checked, and bound to chain, account, request, configuration, nonce, and recovery intent.
- Recovery sessions are encrypted locally and can be exchanged by file, QR, clipboard, or encrypted URL fragment without an operator service.
- Before proposal, the SDK re-reads the active configuration, validator set, nonce, pending recovery, verifier code, proofs, and signatures. Before execution, every pending recovery field must match the reviewed recovery.
- If a deployment does not publish a trusted recovered-validator provisioning path, the application stops with `UNSUPPORTED_RECOVERED_VALIDATOR_PATH` before creating authority or submitting a transaction.

## Consequences

- Roster backup and standby capability delivery are required for operationally complete recovery.
- A passkey alone cannot reconstruct guardian salts.
- Portable artifacts improve walkaway operation but do not replace independent human-code comparison or live chain validation.
- The current Sepolia example can inspect recovery protection and manage portable sessions, but it cannot honestly complete validator replacement until the deployment profile provides a trusted provisioning path consistent with decision 0013.

## Rejected alternatives

- Deterministic PRF-derived guardian salts for new epochs.
- Silently rebuilding old roots with a new salt policy.
- Treating a transport integrity hash as guardian authorization.
- Shipping an incidental validator factory from the UI.
- Assuming device time is authoritative for contract delay readiness.
