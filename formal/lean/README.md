# Lean Model Gate

Lean is reserved for an abstract authority-state-machine model after the
Solidity transition specification is frozen.

The first Lean model must cover:

- validator-set non-emptiness;
- monotonic configuration versions;
- scheduled-operation invalidation after configuration change;
- freeze safety and exact recovery/cancellation exceptions;
- delayed, cancelable, expiring complete-set recovery;
- absence of developer, factory, registry, or provider authority.

Before any Lean theorem is cited as Loom assurance, the repository must also
contain a reviewed refinement table mapping every abstract transition and
precondition to its Solidity function, storage fields, external calls, and
revert behavior. CI must compile every proof.

Until that refinement exists, Lean theorems would prove only the abstract
model and must not be described as proofs of the deployed contracts.
