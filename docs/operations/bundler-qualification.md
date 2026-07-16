# Independent Bundler Qualification

Release qualification requires two independently implemented ERC-4337
bundlers against the target chain and exact EntryPoint bytecode.

For each bundler, retain machine-readable evidence for:

1. `eth_supportedEntryPoints`;
2. counterfactual Loom account deployment;
3. single and atomic batch UserOperations;
4. native account-funded gas;
5. approved and rejected paymaster-bound sessions;
6. invalid signature, stale nonce, malformed calldata, and unsupported mode
   rejection;
7. receipt retrieval and event reconciliation;
8. direct permissionless `handleOps` fallback without the bundler service.
9. account lifecycle operations covering session grant/revoke, recovery
   proposal/cancel, migration schedule/cancel, and vault schedule/cancel.

The upstream `eth-infinitism/bundler-spec-tests` suite must also pass for each
bundler. Passing that suite does not replace Loom account lifecycle tests.

No API-key-only bundler may be the sole tested path. Release evidence must
include one locally operated or otherwise permissionless bundler path.

The manifest must include a `lifecycle` entry for every qualified bundler. Each
entry must prove the same Loom account address completed counterfactual deploy,
single UserOperation, atomic batch UserOperation, native gas, approved paymaster
flow, rejected paymaster flow, invalid signature rejection, stale nonce
rejection, malformed calldata rejection, unsupported mode rejection, and receipt
reconciliation through that specific bundler. It must also include stage
evidence proving session, recovery, migration, and vault operations were
scheduled, cancelled, config-bound, and receipt-reconciled through that
bundler. Aggregate receipts are not enough.

## Evidence Manifest

Release candidates must add a real evidence manifest and validate it with:

```sh
node tools/evidence/validate-bundler-qualification.mjs evidence/bundlers/<network>.json
```

Live qualification evidence must use schema version 2 and be generated from a
local, uncommitted runner config:

```sh
node tools/evidence/run-bundler-qualification.mjs \
  evidence/bundlers/<network>.config.local.json \
  evidence/bundlers/<network>.json
```

The local config must provide:

- `version: 2`;
- the target `network` and exact `entryPoint`;
- an explicit `nodeUrl` used to reconcile chain receipts and post-state;
- at least two independent `bundlers`;
- one metadata-only `lifecycle` entry per bundler;
- one `lifecycleVectors` entry per bundler containing all signed positive
  UserOperations;
- one `rejectionVectors` entry per bundler containing all signed negative
  UserOperations;
- aggregate `checks` and `receipts`, including the separately executed direct
  `handleOps` fallback receipt.

Each `lifecycleVectors[].operations` object must contain `deploy`, `single`,
`batch`, `nativeGas`, `paymasterApproved`, `sessionGrant`, `sessionRevoke`,
`recoveryProposal`, `recoveryCancel`, `migrationSchedule`, `migrationCancel`,
`vaultSchedule`, and `vaultCancel`. Every operation contains a signed
`userOperation` and at least one exact `postState` check:

```json
{
  "userOperation": { "sender": "0x...", "signature": "0x..." },
  "postState": [
    {
      "to": "0x...",
      "data": "0x...",
      "expectedResult": "0x..."
    }
  ]
}
```

Prepare the vectors in execution order. Operations for the second bundler must
use nonces valid after the first bundler's lifecycle completes. Keep the config
local: it contains signed operations and may contain account or infrastructure
metadata that does not belong in release evidence.

## Runner Guarantees

Before writing evidence, the runner:

1. verifies `nodeUrl` and every bundler report the configured chain ID;
2. verifies every bundler advertises the exact EntryPoint;
3. submits all 13 positive lifecycle operations through each bundler in order;
4. polls each UserOperation receipt with a bounded timeout;
5. requires successful inner execution and outer transaction status;
6. reconciles transaction hash, block hash, and block number through
   `nodeUrl`;
7. finds the exact EntryPoint `UserOperationEvent` for the submitted hash;
8. executes every exact post-state `eth_call` at the inclusion block;
9. submits all five negative vectors and requires a negative JSON-RPC error;
10. confirms every rejected UserOperation still has no receipt.

Positive checks, lifecycle stage completion, and positive receipts are derived
from these live results. They are not copied from config declarations. A
duplicate returned UserOperation hash, failed execution, missing event,
receipt drift, post-state mismatch, unexpected negative-vector acceptance, or
poll timeout aborts evidence generation.

The output records only RPC origins and redacted execution evidence:
UserOperation and transaction hashes, inclusion block binding, post-state check
counts, receipt/event reconciliation, rejection codes, and receipt absence. It
does not record `nodeUrl`, full bundler URLs, signed UserOperations, or exact
post-state calls. Do not commit local runner configs.

The manifest intentionally records only RPC origins, not full URLs. Do not
commit API keys, endpoint paths, query strings, bearer tokens, private keys, or
wallet secrets. The validator requires:

- at least two distinct bundler RPC origins;
- at least two distinct bundler implementations;
- at least two distinct operators;
- the expected chain ID and EntryPoint in every bundler response;
- passing upstream bundler spec-test references;
- one lifecycle result per bundler, all using the same account address and
  expected EntryPoint;
- native gas, approved paymaster, rejected paymaster, invalid signature, stale
  nonce, malformed calldata, unsupported mode, receipt reconciliation, and
  atomic batch checks;
- schema version 2; legacy version 1 evidence is rejected;
- per-bundler receipts for deploy, single call, batch call, native gas,
  approved paymaster, session grant, session revoke, recovery proposal,
  recovery cancellation, migration schedule, migration cancellation, vault
  schedule, and vault cancellation;
- per-operation UserOperation hash, transaction and block binding, successful
  receipt reconciliation, successful EntryPoint event reconciliation, and at
  least one exact post-state check;
- rejected paymaster, invalid signature, stale nonce, malformed calldata, and
  unsupported mode evidence containing a negative RPC code, UserOperation hash,
  and explicit receipt absence; rejected operations must not have transaction
  receipts;
- per-bundler stage evidence proving session, recovery, migration, and vault
  flows are scheduled, cancelled, config-bound, and receipt-reconciled;
- one local, self-hosted, or otherwise permissionless direct `handleOps`
  fallback path.

`.github/workflows/bundler-live.yml` provides a manual two-endpoint preflight.
It intentionally fails when the two configured endpoints are identical, when
either endpoint reports the wrong chain ID, or when either endpoint does not
advertise the expected EntryPoint.

The workflow requires:

- `BUNDLER_A_URL`;
- `BUNDLER_B_URL`;
- `ENTRYPOINT_ADDRESS`;
- `BUNDLER_CHAIN_ID`.

`tools/evidence/bundler-smoke.mjs` records only the RPC origin, reported chain ID, and
supported EntryPoints. It rejects credentials, query strings, fragments, and
secret-bearing endpoint parameters. Preflight success is necessary but does
not satisfy the complete lifecycle matrix above; it is the first live gate
before account deployment, native gas, paymaster, rejection, receipt, and
permissionless fallback evidence is collected.

Reference: https://github.com/eth-infinitism/bundler-spec-tests
