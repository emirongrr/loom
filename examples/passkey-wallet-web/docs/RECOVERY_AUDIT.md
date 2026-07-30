# Recovery boundary audit

Date: 2026-07-28

## Verified foundations

- `RecoveryManager` replaces the complete validator set atomically, rotates the guardian root, enforces a three-day delay and seven-day execution window, and supports owner or guardian-threshold cancellation.
- Recovery execution has no arbitrary call target or value authority.
- The SDK owns guardian leaf/proof construction, proposal identities, approval tuples, cancellation digests, chain reads, and calldata.
- Existing guardian capabilities are individualized; the full guardian graph is not disclosed to one guardian.
- Saved wallet handles and legacy account metadata are independent of recovery session storage. This change performs no deletion or destructive migration.

## Blockers found and corrected

1. New guardian roots used salts derived from the owner's passkey PRF. This failed the lost-passkey recovery model and weakened roster privacy after passkey compromise. New epochs now always use independent random salts; legacy roots remain untouched and readable.
2. `proposeRecovery` accepted a previously prepared object without immediately re-reading config version, recovery nonce, validator list, pending state, verifier runtime, Merkle proof, or signature. These are now revalidated immediately before submission.
3. `executeRecovery` checked readiness and config version but did not compare the complete pending record to the reviewed recovery. All committed fields must now match.
4. Recovery had no strict portable request/response protocol or durable lifecycle. The SDK now provides bounded canonical artifacts, and the web example stores encrypted state-machine sessions while isolating corrupt records.
5. Browser AES-GCM envelopes were not bound to their record key. New envelopes use key-bound additional authenticated data; version 1 envelopes remain readable.

## Current production blocker

The bundled deployment publishes an already-installed P-256 validator but no trusted mechanism for provisioning a fresh validator instance for recovered control. Reusing the installed validator is forbidden by the contract and SDK. The UI therefore fails closed with `UNSUPPORTED_RECOVERED_VALIDATOR_PATH`; it does not create a passkey that cannot be installed and does not simulate a successful recovery.

This must be resolved as a deployment/profile decision under decision 0013 before end-to-end proposal and execution can be enabled.

## Deferred surfaces

- Live guardian approval UI for capability V2, including verifier runtime re-check and passkey signature production.
- PRF-wrapped vault unlock plus encrypted export/import recovery for local session keys.
- Owner and guardian cancellation controls in the recovery session UI.
- Optional on-chain mailbox/message board. Manual file/fragment transport remains the required baseline and is implemented first.
