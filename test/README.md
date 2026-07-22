# Loom Test Structure

Loom tests are organized by evidence type. The directory name should tell a
reviewer what kind of claim the test is making and how much of the system is
wired together.

## Directories

| Directory | Purpose | Mock Policy |
|---|---|---|
| `unit/` | Narrow contract, library, validator, hook, or verifier behavior. | Mocks are allowed when they isolate one dependency or create adversarial inputs. |
| `integration/` | Real Loom components wired together across account, validator, hook, recovery, factory, EntryPoint, or SDK boundaries. | Prefer production contracts. Mocks are allowed only for external boundaries, targets, tokens, adversarial hooks, or test-only EntryPoint/paymaster surfaces. |
| `fork/` | Pinned-chain compatibility against deployed external contracts. | Loom components and the external contract under test must be real. RPC URLs remain caller-supplied and uncommitted. |
| `evidence/` | Deterministic external evidence such as WebAuthn fixture corpus validation. | No cryptographic verifier mocks for production claims. Fixture privacy/provenance checks are part of the test. |
| `e2e/` | Node-side wallet developer journeys through SDK, signer, transport, receipt, safety-state, and walkaway boundaries. | In-memory transports are allowed only as external bundler/state boundaries. Do not use them for live-chain claims. |
| `invariant/` | Stateful Foundry invariants over interacting transitions. | Mocks may drive adversarial state transitions but must not replace the invariant target. |
| `formal/` | Formal-style symbolic property tests for Halmos/Kontrol-style bounded execution. | Keep properties small and do not call them complete theorem-prover proofs. |
| `regression/` | Past bug classes, security regressions, branch-coverage hardening, and malicious component tests. | Mocks should model known bad behavior and fail-closed expectations. |
| `mocks/` | Minimal test doubles and adversarial harness contracts. | Must stay visibly test-only and should not encode desired production behavior. |
| `fixtures/` | Solidity test fixtures that are not WebAuthn corpus fixtures. | Generated or private data must not be committed. |

WebAuthn assertion fixtures live under `fixtures/webauthn/` at the repository
root because they are also consumed by Node validation tooling.

## Unit Tests

Unit tests answer: "Does this component enforce its own local contract?"

Examples:

- `P256Validator`: WebAuthn parsing, rpId/origin binding, payload limits,
  low-s rejection, invalid credential rejection.
- `GuardianVerifier`: proof verification, threshold failure, duplicate
  rejection.
- `GranularSessionValidator`: target, selector, token, value, time, use-count,
  and revoke behavior.
- `PolicyHook`: token limits, malformed calldata, paymaster policy, fail-closed
  parsing.
- `VaultHook`: delayed withdrawal, cancellation, expiry, unauthorized
  withdrawal rejection.
- `ExecutionLib`: single/batch decode and unsupported mode rejection.

Mocks are acceptable here when the test is intentionally isolating one
component. A unit test should not claim that the wallet lifecycle works.

## Integration Tests

Integration tests answer: "Does the Loom security model still hold when real
components are composed?"

These tests should prefer real production contracts for the path under review:

- `LoomAccount + EntryPoint + validator + hook + target`
- `LoomAccount + session validator + policy hook + ERC20`
- `LoomAccount + recovery module + guardian verifier + new validator set`
- `LoomAccount + migration + destination account`
- `LoomAccount + vault hook + token portfolio`
- `LoomAccount + ERC-7579 adapter profile`

Mocks are still allowed for external surfaces that are not the claim under
test: target contracts, malicious hooks, non-standard ERC-20s, local paymasters,
or test-only EntryPoint helpers. Do not replace the component whose production
interaction is being claimed.

## Evidence Tests

Evidence tests turn external artifacts into reproducible checks. For example,
the WebAuthn corpus tests verify committed browser/device assertions through
the real P-256 verifier and mutation-negative cases.

Production claims require evidence fixtures that:

- exclude raw user-agent, raw credential ids, user handles, and attestation
  objects;
- pass schema, provenance, and PII checks;
- include negative mutation coverage;
- are bound to the account or operation when the claim is lifecycle-specific.

## E2E Tests

E2E tests answer: "Can a wallet developer use the Loom SDK to run a user-facing
flow end to end?"

Default E2E tests are Node-side and PR-safe. They should cover:

- account deployment preparation;
- user operation signing through an explicit signer adapter;
- broadcast and receipt waiting through an explicit transport adapter;
- ERC-5792 capability reporting and `wallet_sendCalls`;
- app-scoped session grant/revoke journeys;
- recovery, migration, vault, and safety-state review surfaces;
- walkaway operation through a different caller-supplied transport;
- absence of hidden default RPC, bundler, paymaster, or recovery services.

Default E2E may use deterministic fixture signers and in-memory transports
because the SDK does not own browser authenticators or bundlers. Live
bundler/testnet/fork claims require separate rehearsal jobs and evidence.

## Naming

New tests should use descriptive names:

- `Component.unit.t.sol`
- `Flow.integration.t.sol`
- `Property.invariant.t.sol`
- `BugClass.regression.t.sol`
- `Evidence.evidence.t.sol`
- `Flow.e2e.test.mjs`

Existing files may be renamed gradually when touched. Avoid broad renames mixed
with behavior changes.

## Stateful Invariant Programs

`EntryPointMultiAccountInvariant.t.sol` composes two real Loom accounts with the
official EntryPoint, shared production ECDSA validator and policy hook, three
nonce keys per account, and independently funded deposits. Its handler explores
single-account operations, successful mixed bundles, execution failure isolated
to one account, and exact validation-failure rollback of the complete bundle.
The invariants continuously check account-scoped authority, nonce-key identity,
deposit backing, and full cross-account state isolation.

`EntryPointMultiAccountPaymasterInvariant.t.sol` extends that composition with
independent sponsors, an underfunded sponsor, and a reverting `postOp` sponsor.
It checks sponsor/account isolation, exact underfunded-bundle rollback,
beneficiary/deposit conservation, and isolation of a failed sponsored execution
from an independent operation in the same bundle.

The programs model two pre-deployed ECDSA accounts, deterministic local signing,
and local adversarial paymasters. They do not claim coverage of counterfactual
deployment, production paymaster middleware, P-256/WebAuthn, session validators,
recovery, or arbitrary account population; those remain separate integration,
invariant, and evidence boundaries.

## Required Checks

Fast local checks:

```sh
npm run verify:quick
```

Focused checks:

```sh
forge test --match-path "test/unit/**/*.t.sol"
forge test --match-path "test/integration/**/*.t.sol"
MAINNET_RPC_URL=<archive-rpc> npm run test:fork:tokens
forge test --match-path "test/evidence/**/*.t.sol"
forge test --match-path "test/invariant/**/*.t.sol"
forge test --match-path "test/regression/**/*.t.sol"
npm run test:e2e
```

Critical guard mutation testing runs in the weekly nightly workflow rather
than under coverage instrumentation. It temporarily removes selected caller,
timelock, stale-authority, and state-consumption guards in an isolated Foundry
copy. Every mutant must compile and make its named security regression test
fail; compilation failures do not count as killed mutants.

```sh
npm run test:mutation:critical:self-test
npm run test:mutation:critical
```

Full verification:

```sh
npm run verify
```
