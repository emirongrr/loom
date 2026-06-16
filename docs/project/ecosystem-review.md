# Smart Account Ecosystem Review

Research date: 2026-06-14

Updated: 2026-06-16 for vault/security-module comparison.

This document compares Loom with open-source smart-account systems
that are relevant to passkeys, modular permissions, recovery, and Ethereum L2
deployment. It is a design comparison, not an audit of the referenced
projects.

## Executive assessment

Loom's strongest differentiators are its immutable account core, lack of
developer authority, delayed configuration, fail-closed policy enforcement,
guardian freeze, and narrow recovery path for broken hooks.

Loom is behind mature ecosystems in module interoperability, passkey
compatibility, permission expressiveness, ERC-1271 application compatibility,
multi-owner authentication, SDK/tooling, deployment maturity, and audit
history.

Most importantly, Loom currently uses the ERC-7579 mode-byte layout and
module-type numbers, but it is not a plug-and-play ERC-7579 account:

- Only validator and hook module types are accepted.
- Executor and fallback modules are deliberately rejected.
- Single-call calldata is ABI-encoded as a struct rather than using the
  standard's packed `target`, `value`, and `callData` representation.
- Modules do not implement the standard `onInstall` and `onUninstall`
  lifecycle interface.
- Loom validator and hook interfaces are Loom-specific and do not directly
  match ecosystem module interfaces.
- Existing ERC-7579 modules such as SmartSession cannot be installed without
  adapters or account-core changes.

Documentation should describe Loom as ERC-7579-inspired or limited-profile
compatible until conformance tests prove the exact supported surface.

## Compared systems

| System | Relevant strengths | Main tradeoff versus Loom |
|---|---|---|
| Coinbase Smart Wallet | Multiple concurrent EOA/passkey owners, compact owner indexing, cross-chain replayable owner updates | Less emphasis on guardian recovery, graded access, and immutable policy guardrails |
| Clave | Production passkey wallet experience on ZKsync, native P-256 usage, recovery-oriented wallet design | More chain-specific; older contracts are not a general ERC-7579 account core |
| Safe + Safe Modules | Mature multisig, passkey signer contracts, recovery/allowance/4337 modules, long deployment history, formal-verification and audit culture | Proxy/module architecture and broad module authority create a larger trust and audit surface |
| Kernel / ZeroDev | ERC-7579 plugin ecosystem, validators/executors/hooks/fallbacks, composable signer-plus-policy permissions | Greater complexity and more powerful modules than Loom intentionally permits |
| Biconomy Nexus | ERC-7579 account base, extensive audits, deployment and tooling maturity | Upgradeability and broad modular surface increase governance and module risks |
| Alchemy Modular Account | ERC-4337 v0.9, ERC-6900, WebAuthn module, spend/allowlist/paymaster/time hooks, ERC-1271 and token receivers | Upgradeable and maximally modular rather than minimal and immutable |
| ERC-7579 SmartSession | Action policies, UserOperation policies, ERC-1271 policies, ERC-7715 flow, ERC-7739 support | Beta module with a substantially larger policy and integration surface |
| Openfort 7702 Account | EOA, raw P-256 and WebAuthn signers; rich sessions; guardian recovery; gas limits; EIP-7702 onboarding | Experimental, unaudited, upgrade/delegation-specific storage risks |
| MetaMask Delegation Framework | Rich delegations and caveats, ERC-7715-oriented permission flows, audited artifacts | Delegation manager introduces a different and broader authorization model |
| Rhinestone module ecosystem | Social recovery, MFA, cold-storage hooks, module registry, hook multiplexing, scheduled actions | Relies on external modules and registry decisions; broader supply-chain surface |

## Feature matrix

| Capability | Loom | Ecosystem leaders | Gap |
|---|---|---|---|
| ERC-4337 | EntryPoint v0.9 account and integration test | Kernel, Nexus, Alchemy, Coinbase, Safe module | Add live bundler interoperability and validation-rule tests |
| ERC-7579 | Mode-byte layout plus Loom-specific validator and hook concepts | Kernel/Nexus plus SmartSession support full module ecosystem | Prove a limited profile or use standard adapters |
| Passkeys | Single-passkey and up-to-16 credential threshold/MFA validators sharing one WebAuthn verification library | Coinbase multiple passkey owners; Safe signer contracts; Alchemy module | Audit multi-passkey lifecycle and add browser fixtures |
| P-256 verification | Precompile at `0x100`, immutable fallback verifier, low-s check | Safe supports configurable precompile/fallback pair; Clave progressive verifier | Per-chain verifier registry/manifest and EIP-7951 vectors |
| Multiple owners | Timelocked multi-passkey threshold validator for low-risk UserOperations | Coinbase unlimited independent owners; Safe M-of-N | Audit MFA validator and preserve separate high-risk recovery path |
| Recovery | Guardian Merkle threshold, freeze, delayed reconfiguration | Safe recovery modules, Rhinestone recovery modules, Openfort recovery manager | Recovery ceremony, pending recovery state, cancellation and rotation UX |
| Signer agility | Validators are modular; guardian leaves bind salted key commitments to immutable verifier code hashes | Modular accounts can install new signer modules | Independently audit additional guardian verifiers and migration ceremonies |
| Session permissions | Exact-call profile plus granular target/selector/token/counterparty/amount/time/use/paymaster profile | SmartSession and Openfort support broader policy composition and gas policies | Audit granular profile; add ERC-7715 client translation and broader policies only when justified |
| Permission RPC | Contract surfaces only | ERC-7715-aware wallets and SmartSession | Define permission encoding, discovery, query and revoke compatibility |
| ERC-1271 | Primary and session validators deliberately reject arbitrary hashes | Safe/Alchemy broad support; SmartSession uses ERC-7739 | Add a narrowly scoped safe typed-data strategy and counterfactual signatures |
| Cross-chain config | Local `configHash` and monotonic version only | Coinbase cross-chain replayable updates | No trustless cross-chain update or replay-safe migration protocol |
| Batch execution | ERC-7821-style minimal simple batch plus ERC-4337 integration test | Common across modern accounts; some support recursive batches | Add conformance vectors and ERC-5792 client capability reporting |
| Vault separation | Optional `VaultHook` separates daily spend from delayed long-term withdrawals for ETH and canonical ERC-20 movement | Safe allowance module provides delegate/token allowances with reset periods; Argent has guarded/lockable modules | Audit vault hook; add production token rehearsal and private-withdrawal adapter review |
| Executors/fallbacks | Deliberately unsupported | Kernel/Nexus/Rhinestone ecosystems | Limits automation and ecosystem modules, but reduces attack surface |
| Module safety | Timelocked install/remove, bounded counts, broken-hook removal path | Rhinestone registry hook and audited module catalogs | Add module-codehash allowlisting/attestation as optional policy |
| Token receivers | ETH plus stateless ERC-721/ERC-1155 safe-transfer receivers | Common in mature smart accounts | Add integration vectors for major token implementations |
| Contract creation | Can call an external factory | Alchemy can CREATE/CREATE2 directly | Optional; avoid unless a concrete wallet workflow needs it |
| EIP-7702 | Not supported | Openfort, Porto, delegation frameworks | Deliberate non-goal; monitor without coupling immutable core |
| Upgradeability | No proxy or admin | Many modular accounts are upgradeable | Loom advantage for unruggability; migrations require new modules/account version |
| Audits/deployments | Pre-audit, no public deployments | Safe, Coinbase, Nexus, Kernel have stronger deployment history | Independent audit, testnet soak, reproducible deployment manifests |
| SDK/tooling | Contracts only | Kernel, Safe, Coinbase, Rhinestone have SDK ecosystems | Add reference encoder, account client and compatibility test vectors later |

## P-256 and L2 findings

P-256 verification at precompile address `0x100` is available on multiple L2
families, including Base/OP Stack deployments, Arbitrum deployments, and
ZKsync Era. Ethereum's EIP-7951 keeps an interface similar to RIP-7212 while
addressing edge-case security problems in the earlier proposal.

Loom already checks low-s signatures at the application layer, which is a good
defense. However, release qualification must not assume identical precompile
behavior on every chain. Each chain manifest must test valid and invalid
EIP-7951/RIP-7212 vectors and verify the fallback verifier code hash.

Loom's exact canonical `clientDataJSON` requirement reduces parser ambiguity
but is less flexible than common WebAuthn libraries that verify fields and
offsets. It may reject valid browser/authenticator output. Real fixtures from
supported browsers and platforms are mandatory before release.

## What Loom does better

- No upgrade proxy, implementation administrator, developer recovery path, or
  privileged factory.
- Configuration and module changes are delayed and invalidate stale scheduled
  operations.
- Primary passkey authority is intentionally limited to policy-classified
  low-risk execution.
- Policy limits are enforced as hooks for normal and scheduled execution.
- One guardian may freeze without gaining asset-transfer authority.
- A reverting hook cannot permanently prevent its own delayed removal.
- Arbitrary delegatecall, executor authority, and fallback modules are
  intentionally excluded from the immutable account.

These are meaningful security advantages. They should not be discarded merely
to match feature-rich accounts.

## Highest-priority gaps

### P0: Claims and interoperability

1. Build an ERC-7579 conformance test suite and document the exact supported
   profile. Until it passes, stop claiming general ERC-7579 compatibility.
2. Test against at least two independent ERC-4337 v0.9 bundlers on public
   testnets.
3. Publish standard signature, execution-mode, module-installation, and
   counterfactual-deployment test vectors.
4. Add per-chain P-256 precompile/fallback verification vectors.

### P0: Authentication and recovery safety

1. Independently audit the multi-passkey threshold validator and its shared
   WebAuthn verification library.
2. Independently audit additional immutable guardian verifier implementations
   and the salted commitment ceremony. The included verifier is only the first
   implementation of the verifier interface.
3. Audit complete-validator-set recovery and its atomic rollback behavior.
4. Decide whether policy hooks must restrict guardian recovery execution;
   document and test the liveness consequences.

### P0: Vault and large-balance safety

1. Independently audit `VaultHook` before treating it as a savings-layer
   control.
2. Test vault policies against canonical ERC-20s, non-standard ERC-20 return
   values, fee-on-transfer tokens, rebasing tokens, ERC-4626 shares, and bridge
   receipt assets. Keep unsupported classes explicitly out of scope.
3. Add stale-config invalidation, expiry, batch interaction, and policy-removal
   tests around pending withdrawals.
4. Design a private-withdrawal adapter separately. Do not make privacy
   protocols part of the immutable account core.

### P1: Permissions and application compatibility

1. Audit the granular session permission format and add gas limits only if
   validation-rule and bundler interoperability tests prove them safe.
2. Map enumerable query/revoke surfaces into a reference ERC-7715 wallet
   integration without broadening on-chain authority.
3. Evaluate ERC-7739 for safe ERC-1271 typed-data signatures.
4. Evaluate ERC-6492 counterfactual signature support.
5. Add explicit capability reporting and tests for ERC-5792/ERC-7821 batching.

### P1: Operational maturity

1. Reach the branch-coverage gate, especially account and validator rejection
   paths.
2. Add browser-generated WebAuthn fixtures and chain-specific P-256 tests.
3. Add fork tests against official EntryPoint deployments.
4. Complete independent audit and public testnet soak.
5. Publish deterministic deployment and code-hash manifests.
6. Extend the current formal properties to policy rollback, session
   dimensions, guardian uniqueness, and every configuration transition;
   Safe's mature process includes formal verification in addition to audits.

### P2: Optional ecosystem features

- Additional token-receiver interfaces only when required by integrations.
- Optional audited module-registry/codehash policy.
- SDK/reference client and signing encoders.
- Cross-chain config synchronization after a separately audited design.
- EIP-7702 support only as a separate account flavor, not by weakening the
  immutable Loom account.

## Recommended direction

Do not turn Loom into a maximally modular account. Preserve the immutable,
limited-authority core and add compatibility through narrowly scoped,
audited adapters and validators.

The next engineering milestone should be:

1. Audit and expand vault policy tests, including stale config, expiry, batch,
   and non-standard token behavior.
2. Independent audit and browser fixtures for multi-passkey/MFA validation.
3. ERC-7579 limited-profile conformance and honest adapters.
4. Browser/chain P-256 compatibility suite.
5. Live bundler and migration rehearsals with independent publishers.

## Primary references

- Coinbase Smart Wallet: https://github.com/coinbase/smart-wallet
- Clave Contracts: https://github.com/getclave/clave-contracts
- Safe Modules and passkeys:
  https://github.com/safe-fndn/safe-modules and
  https://docs.safe.global/advanced/passkeys/passkeys-safe
- Kernel: https://github.com/zerodevapp/kernel
- Biconomy Nexus: https://github.com/bcnmy/nexus
- Alchemy Modular Account: https://github.com/alchemyplatform/modular-account
- SmartSession: https://github.com/erc7579/smartsessions
- Openfort 7702 Account: https://github.com/openfort-xyz/openfort-7702-account
- MetaMask Delegation Framework:
  https://github.com/MetaMask/delegation-framework
- ERC-7579 reference implementation:
  https://github.com/erc7579/erc7579-implementation
- ERC-4337: https://eips.ethereum.org/EIPS/eip-4337
- ERC-7715: https://eips.ethereum.org/EIPS/eip-7715
- EIP-7702: https://eips.ethereum.org/EIPS/eip-7702
- EIP-7951: https://eips.ethereum.org/EIPS/eip-7951
- Base RIP-7212 deployment:
  https://docs.base.org/base-chain/specs/upgrades/fjord/overview
- ZKsync P-256 precompile:
  https://docs.zksync.io/zksync-protocol/era-vm/differences/pre-compiles
