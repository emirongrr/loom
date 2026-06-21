# Lean Model Gate

Lean is reserved for an abstract authority-state-machine model. It is distinct
from the Halmos/Foundry formal-style symbolic property tests under
`test/formal`.

The current Lean model starts with:

- validator-set non-emptiness;
- monotonic configuration versions;
- freeze safety and exact recovery/cancellation exceptions;
- absence of developer, factory, registry, or provider authority.

Planned model extensions:

- scheduled-operation invalidation after configuration change;
- delayed, cancelable, expiring complete-set recovery;
- migration hash binding and expiry;
- batch atomicity as an abstract all-or-nothing transition;
- a reviewed refinement table connecting each abstract transition to Solidity.

Before any Lean theorem is cited as Loom assurance, the repository must also
contain a reviewed refinement table mapping every abstract transition and
precondition to its Solidity function, storage fields, external calls, and
revert behavior. CI must compile every proof.

Until that refinement exists, Lean theorems would prove only the abstract
model and must not be described as proofs of the deployed contracts.

## Local Commands

Install Lean through `elan`, then run:

```sh
cd formal/lean
lake build
```

The model intentionally has no external mathlib dependency yet. Keep early
proofs small, readable, and connected to a plain-language security property.
