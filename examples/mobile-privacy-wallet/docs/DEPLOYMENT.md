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

## On-chain code hash confirmation

`src/loom/deployment/onChainCodehash.ts`:

- `verifyManifestCodehashesOnChain(manifest, stateTransport)` reads deployed
  bytecode at every manifest-pinned address (`entryPoint`, `accountFactory`,
  `passkeyValidator`, and `p256Verifier` when the mode is
  `fallback-contract`) through the app's own state transport — Helios-verified
  when Helios is configured, explicitly unverified in plain-RPC mode — hashes
  it, and compares it to the manifest's committed code hash.
- It also calls `accountFactory.accountImplementation()` to resolve the
  account implementation address (which has no top-level manifest field of
  its own) and confirms its code hash too.
- It returns a blocked gate per role that does not match, has no bytecode at
  all (not deployed on this chain), or could not be checked because the
  active state transport does not support `getCode`/`ethCall`. An empty
  result means every address the manifest committed a code hash for was
  confirmed on chain through the app's own transport.

This closes the "confirm code hashes on chain" item for any role with a
committed manifest hash, using whatever state transport the app is already
configured with. It does not replace independent reproducible-build
verification — a matching code hash proves the deployed bytecode matches what
the manifest says was deployed, not that the source that produced it was
audited.

## What a production wallet must additionally verify

- **Reproducible bytecode** for the account implementation, factory, validators,
  and verifier — `verifyManifestCodehashesOnChain` confirms the deployed hash
  matches the *manifest*; a production release must separately confirm the
  manifest's hashes were produced by a reproducible build from audited source.
- **EntryPoint version** matches the Loom-supported version.
- **Deployment salts and constructor arguments** reproduce the CREATE2 addresses.
- **Explorer verification** links resolve to verified source.
- **Chain id** matches the intended network before any signing.

## Rule

If the manifest is missing, malformed, or does not match the configured
addresses, account deployment is blocked. Do not add a “skip verification” path.
