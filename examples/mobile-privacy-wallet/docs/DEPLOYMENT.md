# Deployment Verification

A wallet must never trust a contract address just because it arrived in an
environment variable. This example verifies its configured addresses against a
committed **deployment manifest** before deploying an account.

## The manifest

`deployment/manifest.example.json` is the template. Replace every placeholder
before shipping. It records, per chain:

- `chainId`, `entryPoint`, `accountFactory`, `passkeyValidator`,
- `p256Verifier` and `p256VerifierMode` (`native-precompile` or
  `fallback-contract`),
- `codehashes` for each contract,
- optional `deploymentBlock`, `explorerVerification`, and `notes`.

## How verification works

`src/loom/deployment/manifest.ts`:

- `parseDeploymentManifest(json)` structurally validates the manifest and throws
  on malformed input rather than returning a partially-trusted object.
- `verifyDeploymentAgainstManifest(config, manifest)` returns a blocked gate for
  every mismatch: wrong `chainId`, an EntryPoint / factory / validator /
  P-256 address or mode that does not equal the manifest, or a manifest with no
  code hashes. The UI must refuse to deploy while any gate is blocked.

This proves the app is about to use the addresses the maintainers committed to.
It does **not** confirm on-chain bytecode by itself.

## What a production wallet must additionally verify

- **Code hashes on chain** match the manifest (a state read; use the verified
  read path).
- **Reproducible bytecode** for the account implementation, factory, validators,
  and verifier.
- **EntryPoint version** matches the Loom-supported version.
- **Deployment salts and constructor arguments** reproduce the CREATE2 addresses.
- **Explorer verification** links resolve to verified source.
- **Chain id** matches the intended network before any signing.

## Rule

If the manifest is missing, malformed, or does not match the configured
addresses, account deployment is blocked. Do not add a “skip verification” path.
