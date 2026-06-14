# Pre-Audit Review: 2026-06-14

This is an internal security review, not an independent audit. Loom remains
pre-audit and must not secure production assets.

## Fixed findings

### High: scheduled execution bypassed installed policy hooks

`executeScheduled` previously called the committed target directly without
running installed hooks. A delayed token call could therefore exceed an active
policy limit without first removing or changing that policy. Scheduled
execution now runs pre/post hooks. The sole bypass remains the exact delayed
removal of an already-installed hook, which preserves recovery from a broken
hook without creating an arbitrary execution bypass. Hook callbacks use a
pre-check snapshot so scheduled hook installation cannot change the post-check
iteration set mid-execution.

### High: primary authority could clear guardian freeze immediately

The account previously treated `unfreeze()` as a frozen-safe self-call. A
compromised installed validator could therefore submit a UserOperation that
called account execution and cleared the guardian's emergency window
immediately.

`unfreeze()` now rejects calls until `frozenUntil`, and the frozen-safe
execution classifier no longer accepts it. A regression test proves early
unfreeze fails and clearing after expiry succeeds.

### High: optional guardian validator bypassed delayed recovery

The former guardian validator granted guardian threshold signatures broad
UserOperation and ERC-1271 authority. Installing it defeated the visible,
delayed, and cancelable recovery model.

The validator has been removed from production scope. Guardians now have only
two authorities: one-guardian emergency freeze and threshold-approved delayed
recovery.

### Low: exact session accepted the default nonce key

The exact-call session validator accepted a zero permission identifier. That
could collide with ERC-4337's default nonce key and create avoidable account
liveness friction. Zero permission identifiers are now rejected consistently
across both session validators.

## Open security risks

### Resolved high: recovery replaced only one validator

Fixed. Recovery now commits to the complete installed validator set, rejects
partial or unsorted sets, and atomically replaces every old validator with one
new validator after the visible delay.

### Medium: immutable EntryPoint dependency

Each account permanently trusts one EntryPoint address. This avoids a mutable
admin path, but a fatal EntryPoint failure can impair account liveness. Release
qualification must verify official bytecode on every chain. A future migration
design must preserve permissionless user control.

### Medium: guardian configuration can be unusable

The account bounds the threshold but cannot prove that a Merkle root contains
enough distinct, live guardians. Wallet setup must construct and verify the
tree, simulate recovery, and warn before accepting an unusable configuration.
The opaque root alone cannot prove usability without revealing guardians or
verifying a separately designed zero-knowledge setup proof.

### Medium: guardian privacy and signer agility

Partially fixed. Initial configuration now stores salted key commitments bound
to verifier code hashes instead of guardian addresses, and recovery/freeze use
a narrow verifier interface without a registry. A guardian still reveals its
commitment, verifier, salt, proof, and signature when acting. Successful
recovery now atomically rotates to a fresh guardian root so the revealed old
tree cannot authorize another recovery. Stronger membership privacy remains
separate research because it would substantially expand the audit surface.

### Medium: WebAuthn compatibility evidence is incomplete

Loom intentionally accepts a narrow canonical WebAuthn shape. This reduces
parser ambiguity but may reject valid authenticators. Browser-generated
fixtures, device coverage, backup-state policy, and chain-specific verifier
vectors remain release blockers.

### Medium: interoperability is intentionally limited

Loom uses ERC-7579 mode and module concepts but deliberately rejects executors,
fallbacks, delegatecall, and arbitrary ecosystem modules. The limited profile
must remain explicit. Live ERC-4337 bundler tests, capability reporting, and
standard test vectors are still missing.

## Competitor lessons

- Safe demonstrates the required maturity bar: tagged audited releases,
  deterministic deployments, local bytecode verification, live bundler
  compatibility tests, and formal verification.
- Kernel and Biconomy Nexus demonstrate broad ERC-7579 interoperability and
  SDK support. Loom should use narrow adapters where needed instead of copying
  their broader module authority.
- Coinbase Smart Wallet demonstrates compact multi-owner passkey handling and
  permissionless cross-chain replay for a strictly allowlisted set of account
  changes. Loom needs a trustless cross-chain design before offering similar
  behavior.
- Rhinestone demonstrates useful optional modules such as conditional hooks,
  MFA, social recovery, and module registries. These belong outside Loom's
  immutable core and require explicit trust disclosure.
- Alchemy's published WebAuthn and allowlist-hook advisories reinforce two Loom
  rules: authentication context must be bound precisely, and every execution
  entry point must enforce the same policy assumptions.

## Priority order

1. Independent review of account authority, WebAuthn, policy, and recovery.
2. Expand the current Halmos and stateful-invariant properties to cover policy
   rollback, session dimensions, guardian uniqueness, and all configuration
   transitions.
3. Browser-generated WebAuthn fixtures and per-chain P-256 verifier manifests.
4. Live tests against at least two independent ERC-4337 v0.9 bundlers.
5. Deterministic deployment and bytecode verification manifests.
6. A separately reviewed recovery-v2 and trustless cross-chain design.
