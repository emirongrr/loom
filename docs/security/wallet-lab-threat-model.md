# Wallet Lab threat model

## Scope and trust boundary

Wallet Lab is developer tooling. It observes public interfaces and a hermetic
local chain; it is not installed into a Loom account, validator, hook, or
production signer. The trusted computing base for a run is the checked-out
repository, pinned Node/Foundry/Alto toolchain, local OS, generated deployment,
and the runner. Tenderly, explorer, OpenTelemetry export, and remote RPCs are not
required or trusted by the canonical path.

## Assets

- Test credential private scalar and browser authenticator state.
- Run correctness: ordering, correlation, hashes, receipts, state diffs, and
  invariant results.
- Developer workstation process and port ownership.
- CI logs and retained artifacts.
- Production separation: no test credential or instrumentation may gain wallet
  authority outside the devnet.

## Threats and controls

| Threat | Consequence | Phase 1 control | Remaining work |
|---|---|---|---|
| Secret or authenticated endpoint enters an artifact | Credential theft | Recursive field redaction, endpoint origin stripping, test-only credential, artifact mode `0600`; tracing starts after virtual credential provisioning | Add a CI canary corpus and trace-bundle scanner |
| Malicious artifact injects script into the UI | Local code execution or data theft | CSP, no inline script, escaped values, schema validation, loopback binding | Add size/depth budgets before accepting imported bundles |
| Simulation is shown as success | False wallet success | Separate `simulated`, submitted, included, and finalized statuses | Add negative simulation/execution disagreement scenarios |
| Bundler fabricates a receipt | False provenance | Independent UserOp hash, sender, transaction hash, outer receipt status, and state assertions | Compare two RPC providers in non-hermetic runs |
| Timestamp-only correlation joins the wrong operation | Misdiagnosis | Stable run/trace/span IDs, monotonic sequence, UserOp/tx/block identifiers | Propagate W3C trace context through browser and optional services |
| Stale or unrelated processes are killed | Developer data loss | Existing devnet state owns exact PIDs; lab does not enumerate or kill by port | Add explicit port-collision diagnostics to the UI |
| Deterministic test key is used publicly | Asset loss | Test-only module, explicit warning, local chain in canonical runner, no key serialization | Static rule forbidding import from production/example packages |
| Artifact is modified after a run | Misleading evidence | Atomic writes and strict version/schema checks | Add content digest/signature for release evidence bundles |
| Browser storage state is committed | Passkey impersonation | Ephemeral browser context, generated deployment ignored and removed, outputs under ignored `.loom`; private credential provisioning is outside the trace | Add CI assertions over trace contents and retention policy |
| Dev proxy reaches a non-local service | SSRF or unintended data disclosure | Proxy is disabled by default and rejects every target except loopback HTTP | Keep proxy variables out of production hosting configuration |
| Instrumentation changes authority or gas | Production behavior change | No Solidity change; recorder is opt-in in an E2E tool only | Keep future SDK hooks optional, typed, and benchmark disabled overhead |
| Unbounded payload exhausts memory/disk | Local denial of service | Local generated artifact only | Enforce byte, event, nesting, and field-length ceilings before import/export APIs |
| Reorg is missed | Included operation reported as durable | Finality requires a later block and is distinct from inclusion | Add configurable-depth reorg scenario and tracker reconciliation |

## Redaction policy

Private keys, secrets, mnemonics, authorization/cookie values, and browser
storage state are forbidden. Endpoint URLs retain only scheme and origin.
Public test credential ID, public P-256 coordinates, RP ID, origin, challenge,
authenticator flags, signature `r`/`s`, account addresses, UserOperation, and
local transaction evidence are allowed and marked `public-test-only`.

Redaction is defense in depth, not permission to feed production credentials to
the lab. CI and documented commands require no production secret.

## Security assertions

Phase 1 fails unless:

- SDK and independent EntryPoint UserOperation hashes are identical.
- Bundler receipt hash and sender bind to the submitted operation and account.
- The enclosing chain transaction exists and succeeds.
- The native balance changes by the exact authorized amount.
- The target state and canonical nonce change exactly once.
- Account runtime code identity does not change.
- Finality is recorded only after inclusion and the configured later block.
- Any active failing boundary is closed as `error` with a redacted diagnostic.
