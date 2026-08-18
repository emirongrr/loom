# ADR-0025: Initialize the recovery validator when it is deployed

## Status

Accepted and implemented.

## Problem

`RecoveryManager.executeRecovery(account, oldValidators, initData)`
(`src/recovery/RecoveryManager.sol:174`) requires the exact bytes of the new
validator's initializer, and checks them against the hash stored when the
recovery was proposed. `LoomAccount.recoverConfiguration` then forwards those
bytes to `_installModule`, which calls the validator with them
(`src/LoomAccount.sol:578`, `src/LoomAccount.sol:1144`).

Those bytes are never published. `pendingRecoveries` stores only
`initDataHash`, and the portable `RecoveryRequestV1` carries only
`initDataHash` (`packages/sdk/src/recoveryProtocol.ts:41`) because the data
contains the new passkey's public key. They exist in exactly one place: the
device that created the recovery, in its encrypted session and draft stores.

So a recovery that is approved, delayed, and ready can still be impossible to
finish. Losing the browser profile that started it is enough, and the wallet
cannot help: it can read the chain and report `Approved and executable now`
while having nothing to execute with. This is not hypothetical -- it is the
state a live Sepolia account is in as this is written.

The failure is worse than an inconvenience. A pending recovery occupies the
slot: `proposeRecovery` reverts with `RecoveryAlreadyPending` while
`readyAt != 0` (`src/recovery/RecoveryManager.sol:75`), and an expired record is
never cleared by `executeRecovery`. Starting again requires a guardian-approved
cancellation (`cancelRecoveryWithGuardians`), so the guardians have to be
assembled twice.

## Decision

The recovery validator is initialized by its factory, in the transaction that
deploys it, from key material supplied by the caller. The `CREATE2` salt is
derived from that same material, so the validator's address continues to commit
to exactly one key.

`executeRecovery` therefore needs no initializer:
`recoverConfiguration` installs an already-initialized validator, and
`_installModule` makes no call when `initData` is empty
(`src/LoomAccount.sol:1144`).

Nothing has to survive from the device that started the recovery. Any submitter
with gas can finish an approved, matured recovery.

## What this does not change

- Guardians are still identified only by a Merkle root, and an approval still
  reveals only the guardian who gave it.
- The threshold, the delay, expiry, the configuration-version binding, and the
  nonce are untouched.
- Execution stays permissionless. Restricting it to the new passkey's holder
  would add a liveness dependency without adding a security property: the
  outcome is already fixed by the approved proposal, and no submitter can alter
  a field of it.
- The validator's address remains a commitment a guardian can check before
  signing. Today that check is `getAddress(account, nonce, initDataHash) ==
  newValidator`; afterwards the same check is made against a salt derived from
  the key material. A guardian approves "the key committed by this address"
  either way.

## Cost

The new public key becomes visible when the validator is deployed, which is
before guardians approve. Today it becomes visible only when the recovery
executes.

What that does and does not mean:

- It does not enable forgery. A P-256 public key verifies signatures; it does
  not produce them. The private half never leaves the authenticator in any
  variant of this design.
- The key is on chain after execution regardless, so this changes *when*, not
  *whether*.
- It leaks metadata earlier: the initializer also carries `sha256(rpId)` and
  `keccak256(originHash)`, which identify the relying party the passkey belongs
  to.
- A recovery that is abandoned, cancelled, or left to expire now leaves its key
  published, where before it would have revealed nothing.
- A published key has a longer exposure window against a future adversary with
  a quantum computer. For a recovery that completes in days this is marginal;
  for an abandoned one the exposure is indefinite.

The existence of a pending recovery, and the address of its intended validator,
are already public today (`pendingRecoveries` returns `newValidator`, and the
validator is deployed before approvals are collected). The change adds the key
behind that address, not the fact of the recovery.

## Alternative, recorded rather than taken

Store the initializer bytes in the pending recovery record at
`proposeRecovery`, and read them back at execution.

This is better on privacy: the key would become visible only once the guardian
threshold is met, so a recovery abandoned before that reveals nothing. It solves
the device dependency equally well, and needs no log queries.

It costs roughly six storage slots -- the initializer is about 164 bytes -- so
approximately 120k additional gas on the proposal, paid by whoever submits it.

It is not taken now because it is a larger change to `RecoveryManager`'s storage
and proposal surface, and the device dependency is the failure users are hitting
today. **This should be reconsidered before any production deployment**, since
the privacy difference is real and the gas cost is small relative to a
once-in-an-account's-lifetime operation.

## Consequences

- Wire-breaking. `executeRecovery` loses a parameter,
  `P256RecoveryValidatorFactory.deploy` gains the key material, and
  `P256RecoveryValidator.initialize` is no longer callable by the account.

  No migration is provided, and none is needed. The only deployment carrying
  these contracts is a Sepolia test deployment, which is abandoned rather than
  upgraded -- including the recovery pending on it at the time of writing, which
  is exactly the failure this record exists to remove. Nothing reads or writes
  that deployment after this change, so there is no compatibility surface to
  preserve and no state to move.
- The SDK's `PreparedRecovery` no longer needs `initData` to reach execution,
  and the wallet's session and draft stores no longer hold anything that
  execution depends on.
- Loom is pre-audit. This record does not claim the design is audited or
  production-ready.
