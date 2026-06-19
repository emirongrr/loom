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

The upstream `eth-infinitism/bundler-spec-tests` suite must also pass for each
bundler. Passing that suite does not replace Loom account lifecycle tests.

No API-key-only bundler may be the sole tested path. Release evidence must
include one locally operated or otherwise permissionless bundler path.

## Evidence Manifest

Release candidates must add a real evidence manifest and validate it with:

```sh
node tools/validate-bundler-qualification.mjs evidence/bundlers/<network>.json
```

The manifest intentionally records only RPC origins, not full URLs. Do not
commit API keys, endpoint paths, query strings, bearer tokens, private keys, or
wallet secrets. The validator requires:

- at least two distinct bundler RPC origins;
- at least two distinct bundler implementations;
- at least two distinct operators;
- the expected chain ID and EntryPoint in every bundler response;
- passing upstream bundler spec-test references;
- native gas, approved paymaster, rejected paymaster, invalid signature, stale
  nonce, malformed calldata, unsupported mode, receipt reconciliation, and
  atomic batch checks;
- one local, self-hosted, or otherwise permissionless direct `handleOps`
  fallback path.

`.github/workflows/bundler-live.yml` provides a manual two-endpoint preflight.
It intentionally fails when the two configured endpoints are identical.
Preflight success is necessary but does not satisfy the complete lifecycle
matrix above.

Reference: https://github.com/eth-infinitism/bundler-spec-tests
