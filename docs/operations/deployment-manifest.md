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
- reproducibility commands for install, build, verification, and manifest
  validation, all with zero exit status;
- reproducibility file hashes for at least `foundry.toml` and
  `package-lock.json`;
- every deployed Loom contract address, deterministic salt, constructor
  arguments, artifact path, init-code hash, and runtime-code hash;
- account implementation address and runtime-code hash;
- proxy creation-code hash and runtime-code hash used by the factory;
- app registry address, constructor factory address, and runtime-code hash;
- deployment receipt evidence for every contract, including transaction hash,
  deployer, block number, success status, and gas used when available;
- explorer source-verification URL for every deployment;
- signed release attestations from three distinct roles: deployer,
  independent reproducer, and security reviewer;
- checks proving clean-checkout build, local bytecode reproduction,
  EntryPoint verification, `senderCreator` verification, P-256 verification,
  deterministic address reproduction, factory EIP-170 runtime-size compliance,
  explorer verification, no admin or upgrade key, and no Loom service
  dependency.

The validator recomputes init-code and runtime-code hashes from Foundry
artifacts, recomputes configured reproducibility file hashes, and rejects
mismatches. It also rejects explorer URLs containing credentials or common
secret-bearing query parameters. It intentionally does not fetch explorers or
RPC endpoints; network evidence must be reviewed separately and should never
require committing API keys.

The attestation section is not a substitute for audit. It binds the release
manifest to explicit human or organization-level statements that the deployment
was performed, independently reproduced, and reviewed against the release
checklist. Signers must be distinct and must not represent a Loom-operated
service. The validator checks attestation shape and role separation; reviewers
must still verify the signatures and signer identities outside the repository.

Keystore sync deployments need one additional artifact: a passing keystore
proof profile. The deployment manifest proves what was deployed; the keystore
profile proves that the verifier's authority is Ethereum L1 state rather than
L1-to-L2 messaging, bridge attestations, oracle answers, or Loom-operated
services.

## Command

```sh
npm run deployment:manifest:check -- evidence/deployments/<network>.json
```

The evidence directory is intentionally not pre-populated with fake data.

## Candidate Workflow

Production-candidate deployment manifests should be validated with the manual
`deployment-manifest-candidate` GitHub workflow after the evidence PR is
opened. Provide the committed manifest path, for example:

```text
evidence/deployments/sepolia.json
```

The workflow performs a clean checkout, installs pinned dependencies, rebuilds
Foundry artifacts, refuses local-only config paths, and runs:

```sh
npm run deployment:manifest:check -- "$MANIFEST_PATH"
```

It does not fetch private RPC endpoints or explorer API keys. Explorer
verification links in the manifest must be public, credential-free URLs.

## Release Procedure

1. Freeze the audited source commit.
2. Build from a clean checkout with pinned dependencies.
3. Deploy with deterministic salts and public constructor arguments.
4. Record the exact install, build, verification, and manifest-check commands
   with successful exit codes.
5. Record `foundry.toml`, `package-lock.json`, and any additional release
   input file hashes.
6. Verify each deployment's runtime bytecode against the local artifact,
   including the account implementation, proxy runtime, factory, registry,
   EntryPoint, validators, hooks, recovery modules, and verifier contracts.
7. Record deployment transaction hashes, deployer addresses, block numbers,
   receipt status, and gas used.
8. Verify source on the relevant explorer.
9. Record EntryPoint bytecode, account implementation bytecode, proxy bytecode,
   app registry bytecode, and P-256 support evidence for the target chain.
10. Collect deployer, independent reproducer, and security reviewer
    attestations over the final manifest hash.
11. Add the manifest in a dedicated evidence PR and run the validator.

## Non-Goals

- No private keys, API keys, RPC URLs with credentials, or wallet secrets.
- No explorer URLs with `apikey`, `api_key`, `access_token`, `secret`, or
  `token` query parameters.
- No mock deployment manifests.
- No release manifest without distinct deployment, reproduction, and security
  review attestations.
- No production readiness claim from manifest validation alone.
- No chain support unless EntryPoint, P-256 behavior, explorer verification,
  and local bytecode reproduction are all documented.
