# ADR-0027: A passkey locates an account but never grants authority

## Status

Accepted.

Date: 2026-08-27.

## Context

Recovery preserves the account address while replacing its key. Recomputing a
CREATE2 address from the replacement key therefore finds a different account.
Historical validator or factory logs are not a reliable normal lookup path
because an RPC may silently retain only a recent block window.

The product starts with a new credential generation. Old credential discovery
and migration are out of scope.

## Decision

Each wallet receives a random non-zero 32-byte `accountHandle` before its first
passkey is registered. The same value is the factory CREATE2 salt. Every passkey
for that wallet, including a replacement recovery passkey, stores this
versioned 62-byte value in WebAuthn `user.id`:

```text
0x4c | version=3 | uint64 chainId | address factory | bytes32 accountHandle
```

When the account is first deployed, `LoomAccountFactory` atomically asks its
per-factory `AppAccountRegistry` to bind `accountHandle => account`. The registry also
keeps `account => accountHandle`, allowing a recovery flow that already knows the
account to issue a replacement credential with the same identity.

The binding is one-to-one and append-only. The same creation call is
idempotent, while the same wallet ID cannot be used to deploy another account
with different initialization data. The registry has no legacy
membership-only overload: every account admitted by the factory has exactly
one non-zero account handle.

Discovery performs this sequence:

1. request one discoverable credential with user verification;
2. validate the fresh challenge, RP ID hash, origin, cross-origin flag, user
   presence, and user-verification flag;
3. decode and version-check `chainId + factory + accountHandle`;
4. reject the wrong chain or immutable factory generation;
5. resolve the account from the deployment's pinned factory;
6. enumerate only that account's currently installed validators;
7. require the live `(x, y, rpIdHash, originHash)` binding to match the current
   RP and origin;
8. verify the fresh assertion signature against that live public key; and
9. enable signer mode only after every check succeeds.

The locator and registry grant no authority. A copied user handle, a registry
entry, a credential ID, or a human-readable passkey name cannot authorize an
operation. A stale passkey may locate public account data but fails the live-key
check and cannot open Send.

`P256Validator` remains a forward `account => publicKey` authority and does not
gain `accountForKey`.

The browser persists only `AccountHandle` schema v3 under the v3 saved-wallet
namespace. A derived record names `accountHandle` directly; it does not retain a
key-derived `salt` compatibility field. The application neither reads nor
rewrites earlier saved-wallet namespaces.

## Activation boundary

The registry binding is created by the first on-chain account deployment. A
counterfactual wallet that has only been calculated and saved locally is not
yet globally discoverable from another device. The UI must state this boundary,
and a production onboarding flow that promises immediate cross-device recovery
must activate the account before declaring setup complete.

## Front-running consideration

The random account handle is unguessable before it is revealed, but it appears
in the deployment call. A party that can observe and reorder that call could
deploy a different account under the same handle first. This can deny discovery
for the intended counterfactual account, but it cannot grant authority over that
account or its funds: the locator is never accepted without a live validator
assertion.

Loom does not add an activation signer, commit/reveal ceremony, or mandatory
private relay to onboarding. The release accepts this first-binding availability
risk to keep account creation one-step and provider-independent. The one-to-one
registry still prevents silent redirection after an honest binding. Deployment
operations must monitor first activation; a collided, not-yet-funded candidate
is abandoned and recreated with a fresh handle. This tradeoff must be revisited
before production if the deployment environment exposes practical ordering
attacks or if accounts can receive value before activation completes.

## Privacy consequence

The account handle is random and RP-scoped, rather than an address or personal
label. Reusing it across that wallet's recovery credentials intentionally lets
the credential provider correlate those credentials as one RP account. The
chain exposes the ID-to-account binding after deployment. No owner, guardian,
or human label is stored in the identifier.

## Consequences

- Initial and recovery credentials use the same discovery mechanism.
- Recovery key rotation never changes the account handle or account address.
- Normal discovery performs bounded state reads and no historical log scan.
- Saved Wallet data is convenience metadata, never proof of control.
- Earlier browser wallet records are intentionally ignored rather than migrated.
- An unactivated counterfactual account is not cross-device discoverable.
- The factory and registry must be redeployed and their runtime hashes published.
- `accountForKey` storage, ambiguity, and gas are avoided.

## Action items

1. [x] Generate a random account handle before first credential registration.
2. [x] Encode version, chain, factory, and account handle in every new credential.
3. [x] Bind the factory salt to the deployed account in the per-factory registry.
4. [x] Reuse the on-chain account handle when preparing a recovery credential.
5. [x] Remove log-history fallback from the application discovery path.
6. [x] Validate the complete WebAuthn ceremony and live validator binding.
7. [x] Fail closed for missing identities, wrong chains, removed validators, and replaced keys.
8. [x] Reject single-device credentials as cross-device recovery keys by checking WebAuthn BE/BS flags.
9. [x] Remove old saved-wallet migration and key-derived salt compatibility paths.
10. [ ] Deploy the new factory/registry and update the deployment manifest hashes.
11. [ ] Run the clean-device create, activate, recover, rediscover, and stale-key rejection rehearsal.
