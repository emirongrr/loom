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
node tools/validate-bundler-qualification.mjs evidence/bundlers/<network>.json
```

Live qualification evidence should be generated from a local, uncommitted
runner config:

```sh
node tools/run-bundler-qualification.mjs \
  evidence/bundlers/<network>.config.local.json \
  evidence/bundlers/<network>.json
```

The runner performs live `eth_supportedEntryPoints` and `eth_chainId` smoke
checks for every configured bundler before writing evidence. The config may
contain full endpoint URLs because it stays local. The output evidence records
only RPC origins and the validated lifecycle receipts. Do not commit local
runner configs.

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
- per-bundler receipts for deploy, single call, batch call, native gas,
  approved paymaster, rejected paymaster, session grant, session revoke,
  recovery proposal, recovery cancellation, migration schedule, migration
  cancellation, vault schedule, and vault cancellation;
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

`tools/bundler-smoke.mjs` records only the RPC origin, reported chain ID, and
supported EntryPoints. It rejects credentials, query strings, fragments, and
secret-bearing endpoint parameters. Preflight success is necessary but does
not satisfy the complete lifecycle matrix above; it is the first live gate
before account deployment, native gas, paymaster, rejection, receipt, and
permissionless fallback evidence is collected.

Reference: https://github.com/eth-infinitism/bundler-spec-tests
