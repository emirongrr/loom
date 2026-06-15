# Formal Property Program

Formal verification is an audit aid, not a substitute for review, fuzzing, or
production monitoring.

CI runs Halmos symbolic tests against compiled Solidity in `test/formal/`.
The current properties prove, within their harness assumptions:

- arbitrary direct callers cannot change guardian configuration;
- arbitrary direct callers cannot invoke validator recovery;
- unsupported execution modes cannot execute.
- a reverting item rolls back an entire atomic batch;
- a frozen account cannot execute an ordinary call;
- a frozen account cannot execute an ordinary direct call;
- a reverting direct batch rolls back every item and its validator nonce;
- the final validator cannot be removed;
- a successful guardian configuration update advances configuration and
  invalidates a stale scheduled operation;
- recovery cannot execute before its delay and successful recovery replaces
  the complete committed validator set and guardian root.

These are selected safety proofs, not a proof that the wallet is "completely
correct." They do not prove liveness, cryptographic assumptions, compiler
correctness, chain behavior, external token behavior, UI correctness, or all
possible compositions of installed modules.

## Proof layers

1. **Compiled-contract symbolic execution:** Halmos properties exercise the
   actual compiled Solidity behavior and should remain the first executable
   proof layer.
2. **Stateful invariants and fuzzing:** Foundry explores longer transition
   sequences and adversarial inputs that are expensive for symbolic execution.
3. **Rule-based prover:** Before audit freeze, add an independent Certora or
   equivalent rule set for cross-function invariants and environment
   assumptions.
4. **Abstract protocol model:** Lean may model the authority state machine,
   delays, recovery, and liveness arguments. A Lean model is useful only after
   a reviewed refinement relation connects each abstract transition to
   contract behavior. An unlinked Lean model can prove the model correct while
   the Solidity remains wrong, so it must not be presented as bytecode proof.

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

Safe's Certora program and OpenZeppelin's formal specifications are process
references. Loom properties must remain specific to Loom's narrower authority
model.
