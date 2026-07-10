# Wallet Deployment Toolkit

Loom wallet applications should use the shared deployment toolkit instead of
copying app-specific deployment glue. The toolkit lives in
`packages/deployment` (`@loom/deployment`) and gives wallet, fintech, and app
teams one reusable path for:

- extracting app-required contracts from a Foundry broadcast;
- reading live bytecode from the target chain;
- computing code hashes locally;
- writing an app deployment manifest and env values;
- re-reading those files and verifying env == manifest == chain;
- failing closed when any configured app value drifts from the deployed chain.

The mobile privacy wallet example uses this toolkit from
`examples/mobile-privacy-wallet/scripts/connect-deployment.mjs`. That script is
intentionally thin: the deployment logic stays in Loom core, while the example
shows how an app consumes it.

## Core API

Use the module directly when building wallet-specific automation:

```js
import {
  connectWalletAppDeployment,
  createJsonRpcClient,
  deployAndConnectWallet,
  probeP256Precompile
} from "@loom/deployment";
```

`connectWalletAppDeployment` takes:

- `broadcastPath`: Foundry broadcast JSON, usually
  `broadcast/DeploySepolia.s.sol/<chain-id>/run-latest.json`;
- `manifestPath`: app-local manifest output path;
- `envPath`: app-local env output path;
- `manifestReference`: the path the app should store in env;
- `rpc`: a JSON-RPC function, usually `createJsonRpcClient(rpcUrl)`;
- `entryPoint`: expected ERC-4337 EntryPoint address;
- `p256VerifierMode`: `native-precompile` or `fallback-contract`;
- `p256Verifier`: selected verifier address;
- `probeP256`: live P-256 probe used for native precompile mode.

The function writes the manifest and env file only after chain code hashes are
read from the target chain. It then re-loads both files and verifies that the
values did not change between deployment output, app configuration, and live
chain state.

## Example Usage

For the mobile wallet example:

```sh
npm --prefix examples/mobile-privacy-wallet run bootstrap
```

The example bootstrap deploys Loom contracts, then calls its
`connect-deployment.mjs` wrapper, which uses the shared toolkit to write and
verify `deployment/sepolia.manifest.json` plus `.env.local`.

Production apps should keep live manifests local until reviewed. Public,
reviewed evidence can live with the app that consumes it, while generic tooling
and validators remain in Loom core.

## Verification

Run the toolkit tests with:

```sh
npm run deployment:wallet:test
```

`npm run verify:quick` also runs these tests.
