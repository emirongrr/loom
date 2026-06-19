# Deployment Manifest Evidence

Production deployment must be reproducible from source and independently
verifiable without a Loom-operated service. Mature smart-wallet repositories
publish audited release commits, deterministic deployment inputs, deployed
addresses, bytecode verification, and explorer verification evidence. Loom
must meet that bar before any production-funds claim.

`tools/validate-deployment-manifest.mjs` validates a release manifest. It does
not deploy contracts and must not be satisfied with mock addresses or private
test fixtures. A real production-candidate manifest belongs in a dedicated
evidence pull request after public testnet rehearsal.

## Required Evidence

The manifest must include:

- network name, chain ID, EntryPoint v0.9 address, and EntryPoint runtime code
  hash;
- network family (`ethereum`, `op-stack`, or `arbitrum`) and explicit finality
  assumptions;
- EntryPoint `senderCreator` address and runtime code hash;
- P-256 support evidence, either precompile behavior verification or fallback
  verifier address and code hash;
- git commit, clean source archive hash, Solidity version, Foundry version,
  optimizer settings, `viaIR`, and EVM version;
- every deployed Loom contract address, deterministic salt, constructor
  arguments, artifact path, init-code hash, and runtime-code hash;
- explorer source-verification URL for every deployment;
- checks proving clean-checkout build, local bytecode reproduction,
  EntryPoint verification, `senderCreator` verification, P-256 verification,
  deterministic address reproduction, factory EIP-170 runtime-size compliance,
  explorer verification, no admin or upgrade key, and no Loom service
  dependency.

The validator recomputes init-code and runtime-code hashes from Foundry
artifacts and rejects mismatches. It intentionally does not fetch explorers or
RPC endpoints; network evidence must be reviewed separately and should never
require committing API keys.

## Command

```sh
npm run deployment:manifest:check -- evidence/deployments/<network>.json
```

The evidence directory is intentionally not pre-populated with fake data.

## Release Procedure

1. Freeze the audited source commit.
2. Build from a clean checkout with pinned dependencies.
3. Deploy with deterministic salts and public constructor arguments.
4. Verify each deployment's runtime bytecode against the local artifact.
5. Verify source on the relevant explorer.
6. Record EntryPoint bytecode and P-256 support evidence for the target chain.
7. Add the manifest in a dedicated evidence PR and run the validator.

## Non-Goals

- No private keys, API keys, RPC URLs with credentials, or wallet secrets.
- No mock deployment manifests.
- No production readiness claim from manifest validation alone.
- No chain support unless EntryPoint, P-256 behavior, explorer verification,
  and local bytecode reproduction are all documented.
