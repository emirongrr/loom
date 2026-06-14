# WalletBeat Stage 2 Acceptance Matrix

Source of truth: WalletBeat's public `beta` branch. Review this document before
every Loom release because the methodology evolves.

## Contract guarantees

| WalletBeat area | Loom contract guarantee | Evidence |
|---|---|---|
| Account abstraction | ERC-4337 validation and open validator selection | `LoomAccount.validateUserOp` |
| Atomic batching | Batch reverts entirely when any subcall fails | `LoomAccount.execute` |
| Account unruggability | No admin, proxy, or developer recovery authority | Account and factory constructors |
| Account portability | ERC-1271 and ERC-4337; Loom-specific limited module profile | Public interfaces |
| Account recovery | Visible guardian-threshold proposal, delay, cancellation, expiry, and atomic validator/guardian rotation | `RecoveryManager`, account recovery module |
| Permissions management | Exact-call and granular enumerable revocable session permissions plus allowance revoke | `SessionKeyValidator`, `GranularSessionValidator`, `revokeTokenAllowance` |
| Impact mitigation | Low-risk policy limits, timelocks, and freeze | `PolicyHook`, scheduled calls, `freeze` |
| Cross-chain readiness | Versioned local config commitment; no unverified remote mutation path | `configHash`, `configVersion` |

## Required wallet/client work

The contracts alone cannot earn a WalletBeat software-wallet stage.

- Integrate an Ethereum L1 light client and verify chain data.
- Permit custom L1 and L2 node endpoints before relying on default endpoints.
- Build and broadcast permissionless L2 force-withdrawals through L1.
- Provide transaction simulation, calldata interpretation, and clear signing.
- Implement ERC-5792 Wallet Call with atomic capability reporting.
- Keep native-gas and independent-bundler paths available when offering an
  optional token-fee paymaster.
- Support chain-specific address resolution.
- Avoid correlating wallet addresses with user identity or with each other.
- Publish all source under a FOSS license with a reproducible, reviewed release
  process.
- Maintain current audits, a funded bug bounty, and transparent fees/funding.

## Release gate

For every release:

1. Re-run the walkaway test and cypherpunk contract-review questions.
2. Compare WalletBeat `beta` stage definitions and the 1TS security benchmark
   against this matrix.
3. Re-run unit, fuzz, invariant, static-analysis, and bytecode-reproducibility
   checks.
4. Document any changed criterion and whether it is contract or client owned.
5. Prefer the stronger security guarantee when a criterion conflicts with
   account safety.
