# Static Analysis Triage

CI runs Slither `0.11.5` and fails on high-severity findings.

## Intentional patterns

- `arbitrary-send-eth`: locally suppressed only for the authorized smart
  account execution call.
- Low-level calls: required for EntryPoint prefunding, module lifecycle,
  generic account execution, token allowance revocation, and the P-256
  precompile.
- External calls in bounded loops: validator and hook counts are capped at 16
  and 8.
- Timestamp comparisons: security windows are measured in days, making normal
  timestamp drift insignificant.
- Module lifecycle reentrancy warnings: scheduled lifecycle calls execute
  under the account reentrancy guard; malicious initialization rollback has a
  regression test.
- Hook iteration uses the pre-check snapshot, so a scheduled lifecycle change
  cannot alter the post-check set mid-execution.
- Zero-address P-256 fallback verifier: intentional only for deployments whose
  manifest selects `native-precompile` mode and proves target-chain precompile
  support. Fallback-contract mode must use a reviewed verifier address and a
  matching deployed bytecode hash.
- Multi-passkey signature verification calls in a loop: the credential and
  signature counts are capped at 16, and every signature must pass.
- Recovery timestamp equality checks distinguish the zero-value "no pending
  recovery" sentinel from a real multi-day timestamp.
- Recovery guardian verification loops are capped at 32 signatures and proof
  elements. The account's narrow validator-and-guardian replacement entry
  point runs under the execution reentrancy guard.
- Recovery validator installation performs a module initialization call before
  removing the old validator. The entire transition runs under the account
  execution reentrancy guard and reverts atomically on initialization failure.
  The fresh guardian root is applied before that external initialization call,
  so the revealed old guardian tree is no longer active during initialization.
- Recovery's `readyAt == 0` comparisons intentionally use zero as the
  no-pending-recovery sentinel; they are not timestamp equality gates.

Every warning must be re-triaged before audit freeze. New high-severity
findings fail CI and may not be globally excluded.
