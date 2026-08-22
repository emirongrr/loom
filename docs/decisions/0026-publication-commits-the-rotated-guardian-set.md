# ADR-0026: Publication commits the rotated guardian set

## Status

Proposed.

## Problem

ADR-0025 removed the initializer from `executeRecovery`, so finishing an
approved, matured recovery needs nothing that has to survive on the device that
started it. The same question was never asked of the step before it. Proposing
one still does.

`RecoveryManager.proposeRecovery(account, oldValidators, newValidator,
initDataHash, newGuardianRoot, newGuardianThreshold, approvals)` needs six
things beyond the approvals. Five are readable by anyone:

| Input | Where it lives |
| --- | --- |
| `account`, `oldValidators` | the account |
| `newValidator` | the factory's `RecoveryValidatorDeployed` log |
| `initDataHash` | the validator's own `recoveryInitDataHash` |
| `configVersion`, `nonce` | the account and the manager |

`initData` itself is reconstructible too: since ADR-0025 the child stores its
key and policy hook, so `initialize(x, y, rpIdHash, originHash, policyHook)` can
be rebuilt and checked against `recoveryInitDataHash`. Measured against the live
Sepolia validator `0xD79E07D5…e3C62d`, the rebuilt calldata hashes to
`0xc540e49a…3b256cc`, which is exactly what the validator stores.

The sixth has no home. A recovery must rotate the guardian root --
`prepareRecovery` fails `STALE_GUARDIAN_INVITE` if the new root equals the
current one -- and a root is a Merkle root over leaves
`keccak(verifier ‖ verifierCodeHash ‖ keyCommitment ‖ salt)`. Salts are private
and there is deliberately no public guardian registry, so nothing on chain lets
a second device choose the same rotated set. One datum keeps recovery tied to
the originating device, and it is the one datum the chain never sees.

The consequence is not theoretical. A wallet that publishes a validator and then
loses the device holding its roster has paid for a validator it can never
propose, while the account reports itself protected.

## Decision

The publication commits the rotated set. `provisionRecoveryIntent` records
`newGuardianRoot` and `newGuardianThreshold` alongside the key, and the
deployment salt binds them:

```
salt = keccak256(abi.encode(DOMAIN, account, recoveryNonce, initDataHash,
                            newGuardianRoot, newGuardianThreshold))
```

Binding them into the salt is what makes the commitment trustworthy, and it is
not optional. Publication is permissionless and `provisionRecoveryIntent` can
only run once per address, so a root outside the salt would let anyone deploy
the address first with a hostile root and permanently occupy it -- the
legitimate publisher could never deploy their own. With the root in the salt, a
different root is simply a different address, and the published address *is* the
commitment: a reader recomputes it and either it matches or the publication is
not the one they think it is.

`RecoveryManager` is unchanged. It does not need to check the validator's
stored root, because the address already commits to it and the guardians'
digest already binds `newGuardianRoot` and `newGuardianThreshold` -- an approval
authorises that exact rotation and nothing else.

## Consequences

Any device holding the account address can reconstruct the full proposal:
validator and `initDataHash` from the factory log, `initData` from the child,
rotated root and threshold from the child, `oldValidators`, `configVersion` and
`nonce` from the chain. Recovery becomes device-independent from publication
onwards, not just from proposal onwards.

### What this costs

**The rotated root becomes public earlier.** It was already public from the
moment a recovery was proposed; now it is public from publication. A root is a
hash over salted leaves and does not reveal membership, but an abandoned
publication now leaks a root that is never used, where previously an abandoned
publication leaked only a key. This is the same class of early-visibility cost
ADR-0025 accepted for the passkey, and it is accepted here for the same reason:
a recovery nobody can finish is a worse outcome than a hash nobody can invert.

**The rotated set is fixed at publication.** Changing your mind about who the
guardians will be after recovery means publishing again, and paying again. That
is the same rule the key already follows.

**Deployed factories are not upgradable.** The salt changes, so addresses
change, so this needs a new factory deployment. Validators published by the old
factory keep working under the old rules and can still be proposed by the device
that holds their roster; they simply do not carry the rotated set.

### What it does not change

Publishing still grants no authority. A publisher who chooses a hostile rotated
root still needs threshold signatures from the *current* guardians over a digest
that commits to that root, so nothing new is reachable. Guardians still approve
exactly what they see.

## Alternative not taken

`RecoveryManager` could store the rotated set in the pending record instead, or
verify it against the validator at proposal time. Both were rejected: the first
does not help, because the problem is reconstructing a proposal that has not
been made yet, and the second adds a call from the manager into validator code
whose interface `trustedRecoveryValidators` does not require.
