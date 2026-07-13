# Threat Model

## Protected against

- Compromise or malicious behavior by the Loom development team.
- A factory attempting to control accounts it deployed.
- A compromised primary key immediately changing account configuration.
- Duplicate guardian signatures satisfying a threshold.
- Publishing guardian addresses during initial account configuration.
- Duplicate credential identifiers or the same passkey registered under
  multiple identifiers satisfying an MFA threshold.
- Invalid or off-curve P-256 public keys entering validator configuration and
  silently making an account unusable.
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
- Accounts created in guardianless bootstrap mode are not recoverable if the
  primary credential is lost. This is an explicit onboarding tradeoff, not a
  production-safe recovery claim.
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
- Inbound ERC-7579 module shims (`ERC7579ValidatorShim`, `ERC7579HookShim`,
  decision 0010) let one foreign validator or hook run on one account. A shimmed
  module is external code in a validation or hook slot, exactly as trusted as any
  native validator or hook, entering only through the timelocked `installModule`
  path with the same guardian-eviction and scheduled-removal escape hatches. The
  shim reconstructs a narrower profile than native ERC-7579: gas fields,
  `initCode`, and paymaster data beyond the address are zeroed for validators,
  and hook `msgValue` is zero. Modules that read those fields fail closed rather
  than corrupt state, but the incompatibility is silent and must be checked
  against the documented boundary. Each shim binds one account; correct
  target-side state isolation depends on that 1:1 binding. Executor and fallback
  modules and delegatecall remain rejected and are not shimmable. Because the
  foreign target keys its state by the shim address rather than the userOp
  sender, canonical ERC-4337 unstaked-entity storage rules may lead bundlers to
  reject shimmed-validator operations unless staking or bundler policy allows
  them; this is a liveness concern only, and `executeDirect` is unaffected.
- Migration is blocked while frozen. A guardian freeze can delay but not
  permanently veto a migration because freeze duration is shorter than the
  configuration delay and cancellation remains available while frozen.
- Module initialization performs an external call. Constructor initialization
  runs before account runtime code exists; scheduled installation runs under
  the account execution reentrancy guard. Every module init path still belongs
  in audit scope.
- The current repository implements a same-chain Ethereum L1 direct verifier
  and an OP Stack L2 keystore proof verifier, but neither creates a production
  cross-chain authority claim by itself. Production use still requires
  independent audit, target-network profile evidence, finality and reorg
  assumptions, and live rehearsal under
  `docs/operations/keystore-proof-profile.md`.
- The OP Stack L2 keystore verifier roots its trust in Ethereum L1 state read
  through the `L1Block` predeploy's `stateRoot()` plus a caller-supplied
  EIP-1186 proof, with no bridge, oracle, messaging layer, or Loom-operated
  service in the trust path. Under that design the OP Stack sequencer is a
  liveness dependency for state-root currency, not a safety dependency: a
  withheld or stale `L1Block` root can only delay keystore sync, and
  `KeystoreConfig.version` monotonicity plus the `KeystoreSyncRecoveryModule`
  cancellation window prevent a stale root from validating a config the user did
  not author. Until the verifier is audited and rehearsed per target chain, no
  OP Stack production keystore sync safety claim holds.
- EIP-7702 preserves address and assets but introduces persistent delegation
  phishing risk. Users must verify the template address, bytecode, EntryPoint
  binding, and chain before signing a delegation authorization.
- Multiple passkeys improve authentication availability and compromise
  resistance but do not replace guardian recovery.
- Guardianless bootstrap disables guardian recovery, guardian freeze, and
  guardian-threshold cancellation until a non-zero guardian root and threshold
  are added through the delayed configuration path.
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
- The current repository includes SDK state wrappers and a mobile Helios
  state-transport boundary, but it does not yet provide production verified
  wallet evidence. Mobile Helios sync, checkpoint-source review, stale
  checkpoint behavior, target-network profiles, and physical-device rehearsals
  remain release gates.
- The current repository does not implement Railgun, Aztec, stealth-address,
  or privacy-pool adapters. `docs/design/privacy-adapters.md` defines the
  boundary, not a production privacy guarantee.
