# Passkey account discovery SDK

`@loom/sdk/account-discovery` is the canonical implementation of ADR-0027. It
lets a wallet recover the account named by a discoverable passkey without
treating the passkey's `userHandle` or the registry as authority.

## Credential creation

Create one random handle before the first passkey and use the encoded bytes as
WebAuthn `user.id`. The same handle is the account factory's CREATE2 salt.

```ts
import {
  createAccountHandle,
  encodePasskeyAccountLocator
} from "@loom/sdk/account-discovery";

const accountHandle = createAccountHandle();
const userId = encodePasskeyAccountLocator({
  chainId: deployment.chainId,
  factory: deployment.factory,
  accountHandle
});
```

The current format is exactly 62 bytes:

```text
0x4c | version=3 | uint64 chainId | address factory | bytes32 accountHandle
```

Unknown versions, zero handles, zero factories, malformed lengths, and unsafe
chain IDs fail closed.

## Clean-device discovery

The application obtains one discoverable WebAuthn assertion with an empty
`allowCredentials` list, then passes the exact challenge and raw response to
the SDK:

```ts
import {
  createRpcStateTransport,
  discoverPasskeyAccount
} from "@loom/sdk";

const result = await discoverPasskeyAccount({
  chainId: deployment.chainId,
  factory: deployment.factory,
  rpId: location.hostname,
  origin: location.origin,
  challenge,
  blockTag: confirmedBlockNumber,
  assertion: {
    credentialId,
    userHandle,
    authenticatorData,
    clientDataJSON,
    signature
  },
  stateTransport: createRpcStateTransport({ endpoint: primaryRpc }),
  verificationStateTransport: createRpcStateTransport({ endpoint: verificationRpc })
});
```

The SDK validates the handle's chain and immutable factory, WebAuthn type,
challenge, origin, cross-origin flag, RP ID hash, UP and UV flags. It then:

1. resolves `accountForHandle(H)`;
2. reads every value at the same explicit block number;
3. when a verification transport is supplied, requires both RPCs to return
   identical state;
4. reads at most 16 validators installed in that snapshot;
5. reads each P-256 key and its RP/origin bindings; and
6. verifies the fresh assertion against a live key.

The primary state transport is an explicit trust dependency. Applications may
use one trusted RPC, or add an independently operated verification transport
for disagreement detection. The SDK does not infer endpoint independence. A
moving tag such as `latest`, `safe`, or `finalized` is not accepted for account
discovery: resolve the desired confirmed block number first so validator
rotation cannot produce a mixed-state result.

The result is a discriminated union:

- `active`: the assertion verified against the returned live validator. This is
  the only result that may open signer mode.
- `stale`: the handle resolves an account, every validator was inspectable, but
  no live key verified. Do not open the wallet or silently fall back to
  watch-only mode.
- `not-activated`: the valid handle has no account binding in this deployment.
- `invalid`: the handle, deployment binding, or assertion ceremony is invalid.

RPC failure, RPC disagreement, an unreadable validator, or an impossible
validator count throws `AccountDiscoveryError`; none of those conditions is
collapsed into `stale` or `not-activated`.

## Recovery passkey creation

A recovery flow already targets a concrete account. Read that account's stable
handle from both RPCs and write the same v3 locator into the replacement
credential:

```ts
import { readAccountHandle } from "@loom/sdk/account-discovery";

const accountHandle = await readAccountHandle({
  factory: deployment.factory,
  account,
  stateTransport: primary,
  verificationStateTransport: verifier
});
```

`readAccountHandle()` returning `null` means the account is not part of this
new registry generation. Recovery must not invent a new handle.

Use `passkeyBackupState(authenticatorData)` on registration and later
assertions. `backupEligible === false` is an availability signal, not an
authority failure: onboarding and guardian recovery may continue after the
fresh assertion succeeds, while the security UI should explain that this
credential cannot become a synced cross-device credential. `backedUp === true`
confirms a current backup observation; neither flag grants account authority.

The handle and both registry directions are public discovery metadata. Only a
fresh assertion verified against the account's currently installed validator
grants control.
