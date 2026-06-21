# Loom Formal Methods Program

Loom uses layered verification. No single tool is treated as complete proof of
wallet correctness.

## Active Layers

| Layer | Location | Status | Purpose |
|---|---|---|---|
| Foundry fuzz and invariants | `test/` | Active in PR CI | Concrete adversarial exploration and stateful invariant checking. |
| Halmos symbolic properties | `test/formal/` | Active in PR CI | Bounded symbolic execution over selected authority, execution, recovery, and migration properties. |
| Lean abstract model | `formal/lean/` | Research/spec layer | Small theorem-prover model for Loom's authority-state-machine doctrine. Not deployed-contract proof. |

## Planned Layers

| Layer | Location | Status | Purpose |
|---|---|---|---|
| Kontrol / KEVM | `formal/kontrol/` | Targets defined | Reuse Foundry-style specifications with KEVM-backed symbolic execution. |
| Certora CVL | `formal/certora/` | Initial rules defined | Audit-grade source-level rules for cross-function account invariants. |

## Claims Policy

- `test/formal` contains formal-style symbolic property tests, not complete
  theorem-prover verification.
- `formal/lean` proves only the abstract model until a refinement relation maps
  every transition to Solidity storage, calls, and revert behavior.
- Kontrol and Certora specs must state assumptions, unsupported environment
  behavior, and exact target contracts before any result is cited.
- Audit reports and release notes must say which layer produced each result.

## Local Checks

```sh
npm run formal:program:check
npm run kontrol:program:check
npm run certora:program:check
forge test --match-path 'test/formal/*.sol'
halmos --contract LoomAccountAuthorityFormal
```

Halmos, Kontrol, Certora, and Lean may require additional local installation.
CI installs only the tools it actively runs.

## Bug-Class Regression Policy

Historical wallet failures are tracked as bug classes, not as brand references
or marketing claims. Each relevant class must map to at least one executable
test, symbolic property, CVL rule, or documented residual risk before audit
freeze:

- uninitialized account or implementation takeover;
- mutable upgrade/admin control over user accounts;
- arbitrary delegatecall or module backdoor authority;
- signature replay across nonce, chain, account, or configuration domains;
- ERC-1271 signatures approving more authority than the selected validator;
- recovery delay, cancellation, expiry, duplicate guardian, or partial-set
  replacement bypass;
- batch execution leaving partial state after a later call reverts;
- factory or analytics registry becoming account authority;
- EIP-7702 delegated-code phishing and persistent delegation abuse;
- paymaster or token-spend sponsorship exceeding committed policy.
