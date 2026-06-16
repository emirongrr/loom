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
- A default RPC or indexer becoming the wallet's hidden source of truth for
  balances, nonces, recovery status, guardian roots, vault state, validator
  state, or cross-chain identity.
- Loss of the configured EntryPoint permanently preventing authorized account
  publication; installed direct-capable validators can use the same policies
  and hooks without it.
- External callers initializing an EIP-7702 delegated EOA before the user. The
  delegated initializer requires a self-call from the EOA and cannot run on
  constructor-initialized accounts.
- A wallet client, frontend, or bundler disappearing after a user has scheduled
  a delayed exit; any publisher can execute the exact committed migration once
  ready.
- Immediate, stale, expired, cancelled, wrong-destination, wrong-config, or
  wrong-call migration attempts.
- A malicious or compromised primary credential scheduling a dangerous
  migration that the guardian threshold needs to cancel before execution.
- A privacy protocol, scanner, relayer, indexer, prover, or bridge becoming a
  mandatory dependency for ordinary Loom account control, recovery, migration,
  or native-gas operation.

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
- A migration destination is already deployed and independently verified before
  the user commits to its code hash and, when available, `configHash`.
- The underlying chain continues to provide a permissionless transaction
  publication and exit path. Loom cannot compensate for a chain that has
  permanently lost those properties.
- Privacy adapters preserve the account's native control path and accurately
  report their protocol, relayer, indexer, prover, bridge, timing, and metadata
  assumptions.

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
- Sovereign migration is local to one chain and commits to one destination. It
  does not synchronize configuration across chains, prove an L1 keystore root,
  or hide timing and destination metadata.
- Codehash-only migration targets support future account standards that do not
  expose Loom's `configHash()` interface, but they do not prove destination
  owner, guardian, policy, or recovery configuration.
- Migration is blocked while frozen. A guardian freeze can delay but not
  permanently veto a migration because freeze duration is shorter than the
  configuration delay and cancellation remains available while frozen.
- Module initialization performs an external call. Constructor initialization
  runs before account runtime code exists; scheduled installation runs under
  the account execution reentrancy guard. Every module init path still belongs
  in audit scope.
- The current account does not implement cross-chain state proof verification.
- EIP-7702 preserves address and assets but introduces persistent delegation
  phishing risk. Users must verify the template address, bytecode, EntryPoint
  binding, and chain before signing a delegation authorization.
- Multiple passkeys improve authentication availability and compromise
  resistance but do not replace guardian recovery.
- Recovery replaces every validator committed in the visible proposal and
  requires an atomic fresh guardian-root rotation. A guardian acting only to
  freeze still reveals its leaf without rotating the tree.
- A committed guardian verifier becoming unavailable can impair recovery.
  Production configurations should use multiple independent guardians and
  immutable verifier deployments.
- The contracts do not themselves provide private transfers, light-client verification, or
  L2 force-withdrawal construction; those belong to the future wallet client.
- Contracts are unaudited and must not secure production assets.
- The current contract repository cannot itself provide private chain queries,
  private transfers, transaction interpretation, or independent transaction
  publication UX. The future client must satisfy the walkaway and privacy
  requirements in `docs/project/principles.md`.
- The current repository does not implement a verified wallet client. Light
  client verification, privacy-preserving scanning, recovery coordination, and
  SDK state types belong to future client work.
- The current repository does not implement Railgun, Aztec, stealth-address,
  or privacy-pool adapters. `docs/design/privacy-adapters.md` defines the
  boundary, not a production privacy guarantee.
