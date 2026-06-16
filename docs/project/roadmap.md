# Sovereign Wallet Roadmap

Loom's goal is a private, self-sovereign wallet that remains usable without a
Loom-operated service. Convenience providers may exist, but they must always
be replaceable and optional.

`docs/project/principles.md` is the binding product doctrine for this
roadmap. The walkaway test takes precedence over convenience and integration
pressure.

## Non-negotiable constraints

- The account core remains immutable and has no developer administrator.
- Users can submit operations through any compatible bundler or directly
  operate the required infrastructure.
- Native-gas payment always remains available when the chain permits it.
- A paymaster, relayer, RPC provider, indexer, module registry, recovery
  provider, or wallet frontend must never become mandatory account authority.
- Permission grants are explicit, bounded, queryable, and immediately
  revocable.
- Privacy-sensitive services are not trusted with unnecessary account
  correlation data.
- Compatibility features must not introduce arbitrary delegatecall,
  unrestricted executors, or hidden upgrade paths.
- No feature may create a permanent external veto over legitimate account
  operation.
- Every convenience path must preserve a documented provider-independent
  fallback.
- Only the user's local client should need a global view across their
  identities, accounts, and application activity.

## Layer ownership

| Capability | Contract responsibility | Wallet/client responsibility |
|---|---|---|
| ERC-7821 batch | Canonical atomic simple-batch execution | Build and clearly display calls |
| ERC-5792 | Expose truthful on-chain execution capabilities | Implement RPC, status tracking, simulation, and atomic reporting |
| ERC-7579 | Maintain Loom's limited module profile or audited adapters | Discover and explain compatible modules |
| Granular sessions | Enforce target/action/value/time/use/paymaster bounds | Translate permission requests and display exact authority |
| Multiple credentials | Enforce independent credentials and thresholds | Credential creation, backup, health checks, and rotation UX |
| Recovery | Enforce delayed, cancelable, visible recovery state | Notify users and provide provider-independent recovery tools |
| Sovereign migration | Enforce delayed, cancelable, destination-bound exit batches | Build safe asset migration plans and publish through independent paths |
| Vault policy | Enforce stricter delayed movement for long-term storage modules | Separate daily spending from savings and explain withdrawal latency |
| Token-fee paymaster | Bind limited permissions to an explicitly selected paymaster | Quote fees, compare providers, protect privacy, and keep native fallback |
| L1-rooted cross-chain authority | Store canonical identity roots on L1 and apply them only through proof-gated recovery modules | Verify L1 roots, finality, and L2 state without leaking the user's global graph |
| Verified wallet state | Expose deterministic contract state that can be proven from storage | Run light clients, verify proofs, label unknown state, and avoid RPC trust |
| Kohaku SDK stack | Expose bounded account surfaces that Kohaku-backed privacy and account-security tooling can use | Build the Loom SDK layer on Kohaku with local-first scanning, provider profiles, metadata budgets, Railgun, privacy pools, Tornado compatibility, account-security source tracking, and later Aztec wrapping |

## Token-fee paymaster policy

Loom does not include a paymaster in the core and does not trust a default
paymaster. Validators receive the paymaster selected in the UserOperation.
Session permissions default to no paymaster and may authorize exactly one
paymaster.

A future token-fee paymaster integration must:

- Be optional and replaceable.
- Charge only after explicit token, maximum amount, expiry, chain, and
  paymaster approval.
- Avoid unlimited token allowances.
- Bind quotes to the complete UserOperation and a short validity window.
- Publish fee calculation and oracle assumptions.
- Permit native-gas fallback and independent bundler submission.
- Avoid requiring identifying login or cross-account correlation.

USDC or another token is payment to the optional paymaster, not the chain's
native gas asset.

## Delivery order

1. ERC-7821 simple-batch conformance and truthful ERC-5792 capability mapping.
2. Paymaster-bound and granular session permissions. Implemented; requires
   independent audit and ERC-7715 client translation.
3. Multiple independent credentials and threshold/MFA validator. Implemented;
   requires independent audit and client credential-health UX.
4. Visible, delayed, cancelable recovery state machine. Implemented; requires
   independent audit and wallet monitoring UX.
5. Limited ERC-7579 adapters only where they preserve Loom's authority model.
6. Sovereign migration rehearsals and asset-migration atomicity tests.
7. Vault policy hook. Implemented; requires independent audit, production
   token rehearsal, and client monitoring UX.
8. Privacy-preserving client, independent infrastructure paths, and WalletBeat
   Stage 2 validation.
9. L1-rooted keystore. Initial L1 registry and proof-gated sync module are
   implemented; production requires independently audited L1 storage proof
   verifiers per target network.
10. Verified wallet client. Architecture is specified; implementation belongs
    in the future SDK/client and must verify balances, nonces, recovery,
    guardian, vault, validator, and L1 keystore state without making a Loom RPC
    or indexer mandatory.
11. Kohaku SDK stack. Initial architecture and package seed bind Loom's future
    SDK boundary to upstream Kohaku packages as direct dependencies where they
    are published, and as source-level tracked capabilities where they are not.
    Concrete Railgun, privacy-pools, Tornado compatibility, hybrid
    ECDSA-plus-post-quantum account-security, and Aztec flows require separate
    dependency review, provider profiles, protocol threat models, metadata
    budgets, live rehearsal, and audit before production use.

## Core boundary

Privacy adapters, viewing keys, production L1 proof verifiers, and ZK guardian
setup proofs are roadmap items, not current core dependencies. Light clients,
scanning engines, recovery coordinators, and SDK verification layers are also
client-side infrastructure. They must remain optional and replaceable until
their verifier, metadata, liveness, and failure assumptions are independently
reviewed.

The Kohaku SDK stack boundary is documented in
`docs/design/privacy-adapters.md`. Railgun is the default EVM shielded-pool
backend for the SDK through Kohaku. Kohaku account-security tooling is tracked
as a source-level compatibility and migration target for hybrid two-signature
ERC-4337 accounts, not imported into Loom core by default. Aztec is treated as
a separate private-execution environment with separate state, bridge, and
finality assumptions. No protocol or account profile may become a hidden Loom
account authority.
