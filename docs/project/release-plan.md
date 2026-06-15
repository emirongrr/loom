# Release Plan

Work is organized as dependency-ordered vertical slices. Each slice must
produce executable user-visible behavior, tests, documentation, and measurable
evidence.

| Order | Vertical slice | Depends on | Exit evidence |
|---:|---|---|---|
| 1 | Immutable account lifecycle | none | counterfactual deploy, single/batch execution, reproducible build |
| 2 | Passkey authentication | 1 | browser-generated fixtures and physical-device matrix |
| 3 | Graded permissions | 1, 2 | policy/session rejection tests and revoke lifecycle |
| 4 | Sovereign recovery | 1, 2 | delayed cancellation and atomic validator/guardian rotation |
| 5 | Infrastructure independence | 1-4 | two bundlers, direct `handleOps`, optional paymaster lifecycle |
| 6 | Sovereign exit | 1-5 | audited direct execution and permissionless exact migration |
| 7 | Audit candidate | 1-6 | independent audit, resolved findings, public testnet evidence |

## Current position

Slices 1, 3, and 4 have local executable evidence. Slice 2 lacks real
browser/device fixtures. Slice 5 has local EntryPoint and paymaster lifecycle
tests but lacks two live independent bundlers. Slice 6 has direct signed
execution but lacks the exact atomic migration protocol and dedicated audit.
The repository is therefore pre-audit and not production-ready.

Unknown or research-heavy work should begin with a small proof of concept and
an explicit acceptance metric before entering the immutable core.
