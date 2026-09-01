# Canonical Research Source: Recovery Passkey Account Discovery

Audience: Loom protocol, wallet, recovery, and security engineering.

Date: 2026-08-27.

Decision: how a recovery passkey, later selected on a clean unrelated device,
can locate the account it currently controls without Loom local state, a hosted
account index, historical log scans, or an old credential.

## Scope And Assumptions

- A new immutable deployment generation is allowed; legacy-wallet migration is
  excluded.
- The recovery credential is created during a recovery ceremony that already
  targets an exact account. Later use starts from an empty browser profile.
- “No prior relationship” means no Loom local storage or Loom backend. It cannot
  mean that the credential private key is absent from the new device: the
  credential must arrive through password-manager sync, credential exchange,
  cross-device authentication, or a hardware authenticator.
- Locators are never authority. A fresh assertion against an account's current
  validator set is required before signer mode.
- Activation signer and commit/reveal remain excluded by prior product choice.

## Direct Answer

Use a random, stable, per-account `accountHandle` inside the discoverable
credential's WebAuthn `userHandle`. During recovery, read the existing locator
from the account registry and give exactly that value to the newly created
recovery credential. When the credential is later synced or imported to a clean
device, an empty-`allowCredentials` assertion returns the stored `userHandle`.
The wallet decodes the deployment and locator, performs one registry lookup,
then verifies that same fresh assertion against the located account's live,
bounded validator set.

This is not an invented WebAuthn side channel. WebAuthn defines `userHandle` as
the RP account identifier, requires it in discoverable credential sources, and
requires it to be returned during username-less discovery. FIDO's credential
exchange format includes the original `userHandle` as a non-editable passkey
field. The credential therefore carries the locator with its key material.

## Claim Gap Matrix

| Claim | Evidence | Confidence | Contradiction / limit | Resolution |
| --- | --- | --- | --- | --- |
| A discoverable passkey carries and returns its account handle | W3C WebAuthn L3 user-handle and credential-source definitions | High | `userHandle` may be null when a credential allow-list is supplied | Discovery must use empty `allowCredentials` |
| The handle travels with a backed-up or exchanged passkey | W3C credential-source backup model; FIDO CXF passkey dictionary | High for model/exchange | WebAuthn does not mandate that any particular provider sync | Record BE/BS, disclose provider availability, and use a real second-device rehearsal as release evidence |
| A clean Loom client can verify current authority after lookup | Current `App.tsx`, `P256Validator`, validator cap 16 | High | Locator output is not itself signed authority | Verify the fresh assertion against every current validator; fail closed |
| Credential ID is a worse canonical recovery locator | W3C unique-per-credential and unsigned-ID rules; recovery changes credentials | High | It can be a standard database lookup in hosted RPs | On chain it needs a new binding per recovery and retains a first-claim DoS race |
| Direct account address in the handle is not preferable | W3C random/non-PII guidance; current CREATE2 init-code dependency; ERC-4337 initial-signature guidance | Medium-high | Recovery already knows the address | It leaks a directly correlatable address and does not unify the initial credential lifecycle |
| Implementation at the research snapshot was close but incomplete | Local source and 18 targeted passing tests | High | The snapshot's v2 handle omitted factory and its availability UX was incomplete | Add deployment-domain v3 and explicit availability guidance, then run a real clean-device rehearsal |

## Architecture Decision

### Credential envelope

Use a 62-byte versioned handle:

```text
0x4c | version=3 | uint64 chainId | address factory | bytes32 accountHandle
  1       1              8               20                  32
```

This is within WebAuthn's 64-byte limit. `accountHandle` is random, non-zero,
RP-scoped, and non-PII. Factory inclusion distinguishes immutable deployment
generations on the same chain. The authenticator already scopes the credential
to the RP ID; the live validator separately binds RP ID and origin hashes.

### Recovery-time write

The recovery session necessarily names the target account. It reads
`handleForAccount(account)` from two trusted RPC endpoints, verifies agreement
and factory membership, then calls `navigator.credentials.create` with the
same locator envelope. The new P-256 public key is provisioned into the
recovery validator and guardian approvals bind its exact initializer hash.
Recovery execution changes validators, not the locator registry.

### Clean-device read

The wallet calls `navigator.credentials.get` before any awaited network work,
with `allowCredentials` empty and UV required. The chosen credential returns
`rawId`, `userHandle`, authenticator data, client data, and signature. The
client validates challenge, origin, RP ID hash, UP/UV and the envelope, resolves
one account, reads at most 16 live validators, and accepts only the validator
whose current P-256 key verifies the fresh assertion.

### State classification

- `FOREIGN_OR_INVALID`: malformed envelope, wrong chain/factory/RP/origin,
  failed ceremony, RPC disagreement, or untrusted deployment.
- `NOT_ACTIVATED`: valid Loom envelope but zero registry result in its exact
  factory. This is not a claim that the credential is unused globally.
- `ACTIVE`: locator resolves and a current validator verifies the assertion.
- `STALE`: locator resolves but no current validator verifies it; Saved Wallets
  and Send remain closed.
- `UNAVAILABLE`: credential is not present on the new device/provider; no
  locator architecture can reconstruct the absent private key.

## Portability Requirement

The cross-device promise requires a multi-device credential. WebAuthn exposes
per-credential BE (backup eligible, permanent) and BS (currently backed up,
mutable) bits in signed authenticator data. A BE=0 credential can never be
backed up. Registration must parse and retain these flags, but they are not
authority and must not block account creation or guardian recovery. The
Security surface must describe BE=0 as authenticator-bound, BE=1/BS=0 as
sync-eligible but not currently reported as backed up, and BE=1/BS=1 as backed
up. The strongest readiness evidence is a real second-device rehearsal.

Google Password Manager and iCloud Keychain document passkey synchronization,
but platform/provider availability is not a WebAuthn protocol guarantee. FIDO
CXF preserves `credentialId`, `rpId`, `userHandle`, and the key during supported
credential exchange. Loom must promise “no Loom-side state” rather than “no
credential provider or transfer mechanism.”

## Rejected Alternatives

### `credentialIdHash => account`

This precisely identifies a credential, but each recovery creates a new
credential ID and therefore requires a new on-chain binding. Credential ID is
not signed; after a public recovery intent reveals the locator, a competing
account can claim the same unrelated ID hash unless the registry admits
candidate sets or another prior reservation. Candidate sets reintroduce
attacker-sized discovery. Live assertion prevents theft but not durable lookup
DoS. Stable account locator avoids every recovery-time namespace allocation.

### `keyCommitment => account`

The public key is returned only at registration, not in a later clean-device
assertion. Without a candidate account/public-key record, the clean client
cannot compute the commitment. Recovery also intentionally changes the key.

### Account address directly in `userHandle`

It works for a recovery credential because recovery already knows the address,
but it exposes a directly correlatable on-chain identifier where WebAuthn
recommends a random opaque handle. It also fails to give one lifecycle to the
initial credential: the current CREATE2 address depends on initializer/key data
that is returned only after credential creation. Redesigning the account to
make its address independent of initial credentials weakens the ERC-4337
guidance that the generated address depend on the initial signature and creates
a new initialization security problem.

### `largeBlob`, PRF, and hosted index

`largeBlob` is optional and cannot be written during registration; absence is
ambiguous. PRF can protect data but does not tell a clean client where to find
that data and is optional. A hosted credential index is conventional but makes
Loom service availability part of the recovery path.

## Implementation Plan

1. Freeze ADR invariants and use `accountHandle` across the new generation;
   retain no legacy ABI aliases.
2. Implement and fuzz the exact v3 62-byte codec with chain and factory domain
   binding. Keep the 32-byte locator as CREATE2 salt and registry key.
3. Rename registry/factory surfaces to `accountForHandle` and
   `handleForAccount`; preserve factory-only, one-to-one, atomic registration.
4. During recovery, dual-read the handle from the exact account and create the
   new discoverable credential with the same v3 bytes.
5. Parse registration authenticator data and record BE/BS as availability
   guidance. Add a post-creation proof assertion before any recovery validator
   publication or guardian request.
6. Keep recovery provisioning device-independent: publish the validator with
   its exact P-256/RP/origin binding before proposal, and keep guardian approval
   bound to the initializer hash. Locator registry state does not rotate.
7. Refactor clean-device discovery into a pure state machine implementing
   `FOREIGN_OR_INVALID`, `NOT_ACTIVATED`, `ACTIVE`, `STALE`, and `UNAVAILABLE`.
8. After `ACTIVE`, store returned `credentialId` only as a local fast path for
   later targeted assertions. Never use it as canonical account discovery.
9. Make Saved Wallets convenience-only. A stale credential never opens signer
   or implicit read-only mode; watch-only import is a separate explicit action.
10. Add unit, contract, adversarial, virtual-authenticator, and real-device
    clean-room tests; then deploy a new immutable generation and refresh the
    canonical deployment evidence.

## Acceptance Criteria

- Start with a blank browser profile and empty Loom storage on device B.
- The recovery passkey created on device A is available through its credential
  provider or a standard transfer route.
- Selecting that passkey, without entering an address, scans no logs and calls
  no Loom backend, resolves exactly one account, and enables signer mode only
  after the fresh assertion matches a current live validator.
- After recovery, the new passkey is `ACTIVE`; a removed old passkey is `STALE`.
- Wrong chain, factory, origin, RP, challenge, malformed handle, and RPC
  disagreement all fail closed.
- A BE=0 credential is clearly presented as authenticator-bound, without
  blocking account creation or guardian recovery.
- Recovery succeeds even if the device that created the recovery proposal and
  its local draft disappear after the validator has been provisioned.

## Evidence And Verification Performed

The research snapshot implemented a 42-byte chain+wallet-ID handle, reverse
lookup during recovery, empty-allow-list discovery, dual-RPC lookup, bounded
live-validator verification, and stale-key detection. On 2026-08-27, the four
targeted Node test files covering handle encoding, recovery passkey preparation,
discovery order/live verification, and stale account control passed 18/18.
Missing from that snapshot were factory-domain encoding, explicit
portability policy/BE-BS checks, a clean-device sync/import E2E, and final
terminology/status cleanup.

## Claim-To-Source Ledger

| Source | Publisher / date | Claims used | URL / access |
| --- | --- | --- | --- |
| Web Authentication Level 3 | W3C Recommendation, 2026-08-25 | Discoverable `userHandle`, 64-byte limit, credential-source contents, empty allow-list behavior, BE/BS, unsigned credential ID, verification | <https://www.w3.org/TR/webauthn-3/>; accessed 2026-08-27 |
| Credential Exchange Format 1.0 | FIDO Alliance Proposed Standard, 2025-08-14 | Exported passkey preserves `credentialId`, `rpId`, `userHandle`, and key; only display fields editable | <https://fidoalliance.org/specs/cx/cxf-v1.0-ps-20250814.html>; accessed 2026-08-27 |
| Passkey support on Android and Chrome | Google for Developers, updated 2025-05-19 | Password-manager sync, new-device decryption, provider opacity, cross-device auth | <https://developers.google.com/identity/passkeys/supported-environments>; accessed 2026-08-27 |
| Passkeys | Apple Developer | iCloud Keychain synchronization and cross-device availability | <https://developer.apple.com/passkeys/>; accessed 2026-08-27 |
| Server-side passkey authentication | Google for Developers | User identification via `userHandle` or credential ID, then signature verification | <https://developers.google.com/identity/passkeys/developer-guides/server-authentication>; accessed 2026-08-27 |
| ERC-4337 | Ethereum Improvement Proposals | Counterfactual account factory flow and recommendation that generated address depend on initial signature | <https://eips.ethereum.org/EIPS/eip-4337>; accessed 2026-08-27 |
| EIP-1014 | Ethereum Improvement Proposals, 2018-04-20 | CREATE2 address depends on deployer, salt, and init-code hash | <https://eips.ethereum.org/EIPS/eip-1014>; accessed 2026-08-27 |
| Loom working snapshot | Local repository at `cf09f60cdce2009604acad24ca28e30f7cda699b`, dirty | Current registry, factory, validator, recovery and frontend behavior | Local files inspected 2026-08-27 |

## Search Record And Stop Reason

Searches covered WebAuthn discoverable credential/user-handle semantics,
credential-source backup state, passkey sync and exchange, credential-ID
security, platform availability, CREATE2 and ERC-4337 account creation, plus the
complete relevant Loom source paths. Follow-up resolved the consequential gap:
sync is provider-dependent, while `userHandle` preservation is part of the
credential model/exchange format. Research stopped because every architecture
decision and material limitation has primary evidence, alternatives were
disconfirmed against the target invariants, and another broad search was
unlikely to change the selected design.
