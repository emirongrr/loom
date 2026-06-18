# Local Lifecycle Rehearsal

`npm run rehearsal:local` runs the smallest repeatable local rehearsal for
account lifecycle work before live deployment evidence exists.

It executes:

1. account SDK lifecycle intent builders;
2. EntryPoint counterfactual account lifecycle tests;
3. sovereign migration lifecycle tests;
4. vault withdrawal lifecycle tests.

The command is intentionally local and deterministic. It uses Foundry tests and
does not require a Loom RPC, bundler, paymaster, relayer, indexer, frontend, or
recovery coordinator.

## What It Proves

- Account lifecycle builders remain side-effect free.
- Counterfactual ERC-4337 deployment and sponsored/native-gas paths still
  compile and execute in the repository test harness.
- Migration delay, destination binding, cancellation, expiry, atomic rollback,
  alternate EntryPoint destination, and codehash-only destination scenarios
  still pass.
- Vault daily spending, delayed withdrawals, native ETH path, guardian
  cancellation, expiry, and rollback scenarios still pass.

## What It Does Not Prove

- It is not a public testnet or mainnet rehearsal.
- It does not prove interoperability with two live independent bundlers.
- It does not exercise real ERC-20 portfolios, bridge receipts, ERC-4626
  shares, LP positions, or non-standard token behavior beyond the repository
  mocks.
- It does not prove private withdrawal safety against a live Railgun,
  privacy-pool, Aztec, relayer, prover, or indexer.
- It does not replace independent audit, deployment manifests, bytecode
  reproduction, or live migration and vault rehearsal evidence.

## Release Use

Run this command before any PR that touches account lifecycle, migration,
vault policy, EntryPoint integration, account SDK builders, or private vault
withdrawal bindings:

```sh
npm run rehearsal:local
```

Release candidates still require the live gates in
`docs/security/production-readiness.md`.
