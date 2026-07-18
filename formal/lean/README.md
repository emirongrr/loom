# Lean Model Gate

Lean is reserved for an abstract authority-state-machine model. It is distinct
from the Halmos/Foundry formal-style symbolic property tests under
`test/formal`.

The current Lean model starts with:

- validator-set non-emptiness;
- monotonic configuration versions;
- freeze safety and exact recovery/cancellation exceptions;
- recovery scheduling and execution delay against an explicit abstract clock;
- recovery execution-window expiry;
- recovery replacement identity binding for the complete validator set;
- migration scheduling and execution delay against the same abstract clock;
- migration execution-window expiry;
- migration execution binding to the scheduled call commitment;
- migration destination, code-hash, and optional config-hash binding;
- rejected direct execution preserving its validator nonce;
- batch execution as an all-or-nothing state transition;
- guardianless bootstrap granting no guardian authority;
- guardian authority cannot perform validator actions;
- external recovery calls preserving authority state;
- absence of developer, factory, registry, or provider authority.

Planned model extensions:

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
