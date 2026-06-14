# Threat Model

## Protected against

- Compromise or malicious behavior by the Loom development team.
- A factory attempting to control accounts it deployed.
- A compromised primary key immediately changing account configuration.
- Duplicate guardian signatures satisfying a threshold.
- Publishing guardian addresses during initial account configuration.
- Duplicate credential identifiers or the same passkey registered under
  multiple identifiers satisfying an MFA threshold.
- A session signer using a revoked, expired, future, or altered permission.
- A compromised low-risk key changing session permissions immediately or
  sending policy-controlled ERC-20 calls to an unapproved counterparty.
- Guardians gaining general UserOperation or ERC-1271 signing authority.
- Hidden, immediate, replayed, expired, or stale-config validator recovery.
- A recovery module transferring assets or invoking arbitrary account calls.
- Unsupported execution modes and arbitrary delegatecall execution.
- Replaying stale scheduled configuration after a config version change.
- A single guardian being unable to move assets while still being able to
  trigger an emergency freeze.
- A Loom-operated service, default infrastructure provider, or module registry
  becoming a permanent account-liveness dependency.

## Assumptions

- The configured EntryPoint is authentic.
- Installed validators and hooks are trusted by the account owner and have
  been reviewed.
- The installed recovery module is the audited immutable `RecoveryManager`;
  any recovery module can exercise the narrow validator-replacement authority.
- A malicious or broken hook can deny normal execution for the 72-hour config
  delay. Scheduling removal of an already-installed hook has a narrow
  hook-bypass recovery path, so the denial is not permanent.
- Guardian devices and social relationships are sufficiently independent.
- P-256 precompile or configured fallback verifier behaves correctly.
- MFA credentials described as independent are controlled through genuinely
  independent devices or security domains.
- Wallet clients clearly explain calls and do not trick users into granting
  unsafe policies.
- The underlying chain continues to provide a permissionless transaction
  publication and exit path. Loom cannot compensate for a chain that has
  permanently lost those properties.

## Known limitations

- Granular session permissions recognize only Loom's exact single/batch
  execution encoding and canonical ERC-20 `transfer`, `transferFrom`, and
  `approve` calldata. Non-standard token methods and richer allowlists require
  a separately audited validator profile.
- Token policy accounting recognizes standard ERC-20 `transfer`,
  `transferFrom`, and `approve` calldata and can bind their recipient or
  spender to one address. Rich allowlists and non-standard token methods
  require a separately audited policy version.
- Hook callbacks are fail-closed. This prevents policy bypass but makes hook
  availability part of account availability during the removal timelock.
- Timelocked execution still passes through installed hooks. The only hook
  bypass is the exact delayed removal of an already-installed hook, preserving
  recovery from a broken hook without bypassing policy for arbitrary calls.
- Module initialization performs an external call. Constructor initialization
  runs before account runtime code exists; scheduled installation runs under
  the account execution reentrancy guard. Every module init path still belongs
  in audit scope.
- V1 does not implement cross-chain state proof verification.
- Multiple passkeys improve authentication availability and compromise
  resistance but do not replace guardian recovery.
- Recovery replaces every validator committed in the visible proposal and
  requires an atomic fresh guardian-root rotation. A guardian acting only to
  freeze still reveals its leaf without rotating the tree.
- A committed guardian verifier becoming unavailable can impair recovery.
  Production configurations should use multiple independent guardians and
  immutable verifier deployments.
- V1 does not itself provide private transfers, light-client verification, or
  L2 force-withdrawal construction; those belong to the future wallet client.
- Contracts are unaudited and must not secure production assets.
- The current contract repository cannot itself provide private chain queries,
  private transfers, transaction interpretation, or independent transaction
  publication UX. The future client must satisfy the walkaway and privacy
  requirements in `docs/project/principles.md`.
