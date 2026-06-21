# Formal Property Program

Formal verification is an audit aid, not a substitute for review, fuzzing, or
production monitoring.

CI runs formal-style Halmos symbolic property tests against compiled Solidity
in `test/formal/`. These checks are designed for Halmos or Kontrol-style
symbolic execution and remain Foundry-compatible. The current properties
exercise, within their harness assumptions:

- initialized accounts cannot be initialized a second time;
- delegated account initialization rejects direct external callers;
- immutable proxy deployment initializes proxy storage without mutating
  implementation storage;
- immutable proxy deployment exposes no mutable upgrade/admin selector path;
- rejected direct execution through an uninstalled validator does not consume a
  validator nonce;
- arbitrary direct callers cannot change guardian configuration;
- arbitrary direct callers cannot invoke validator recovery;
- unsupported execution modes cannot execute;
- a reverting item rolls back an entire atomic batch;
- a frozen account cannot execute an ordinary call;
- a frozen account cannot execute an ordinary direct call;
- a reverting direct batch rolls back every item and its validator nonce;
- the final validator cannot be removed;
- a successful guardian configuration update advances configuration and
  invalidates a stale scheduled operation;
- guardians cannot perform validator-only ordinary execution;
- validators cannot perform guardian/recovery-only configuration actions;
- direct external calls to account-internal privileged functions revert;
- recovery cannot execute before its delay;
- successful recovery replaces the complete committed validator set and
  guardian root;
- migration cannot execute before its delay;
- migration rejects a non-committed call batch without consuming the pending
  migration;
- a reverting migration batch rolls back earlier calls and preserves the
  pending migration.

These are symbolic property tests, not complete mathematical formal
verification and not theorem-prover proofs that the wallet is "completely
correct." They do not prove liveness, cryptographic assumptions, compiler
correctness, chain behavior, external token behavior, UI correctness, or all
possible compositions of installed modules.

See `test/formal/README.md` for local Foundry and Halmos commands.
See `formal/README.md` and `formal/refinement/account-authority.md` for the
tooling roadmap and refinement map.

## Proof layers

1. **Compiled-contract symbolic execution:** Halmos properties check selected
   behaviors of the actual compiled Solidity and should remain the first
   executable symbolic-property layer.
2. **Stateful invariants and fuzzing:** Foundry explores longer transition
   sequences and adversarial inputs that are expensive for symbolic execution.
3. **Rule-based prover:** Before audit freeze, add an independent Certora,
   Kontrol, or equivalent rule set for cross-function invariants and
   environment assumptions.
4. **Abstract protocol model:** Lean may model the authority state machine,
   delays, recovery, and liveness arguments. A Lean model is useful only after
   a reviewed refinement relation connects each abstract transition to
   contract behavior. An unlinked Lean model can prove the model correct while
   the Solidity remains wrong, so it must not be presented as bytecode proof.
5. **EVM-aligned proof systems:** Kontrol/KEVM and Certora are the preferred
   next professional layers for audit-candidate properties. They should be
   added only with pinned versions, reproducible commands, explicit
   assumptions, and runtime evidence.

## Next required properties

- configuration version is monotonic across every successful transition;
- recovery cannot execute with partial, duplicate, unsorted, stale, cancelled,
  expired, or replayed proposals;
- failed atomic batches and failed hook checks leave no spending effects;
- scheduled execution cannot bypass an active policy;
- no module lifecycle path can remove the final validator;
- only the exact delayed installed-hook removal path can bypass hooks;
- session permissions cannot authorize any call outside every committed
  dimension;
- guardian proofs cannot count a leaf twice;
- every successful module/config transition preserves module count bounds.
- rejected and reverting direct execution cannot consume a validator nonce;
- one direct-capable validator cannot advance another validator's nonce.
- migration cancellation, expiry, stale-config rejection, and destination
  binding need additional symbolic coverage beyond the current unit tests.
- proxy/factory/registry property tests should be expanded to cover every
  deployment manifest invariant before audit freeze.

Safe's Certora program and OpenZeppelin's formal specifications are process
references. Loom properties must remain specific to Loom's narrower authority
model and must not be marketed as complete proof without a reviewed proof
scope, assumptions, and independent audit evidence.
