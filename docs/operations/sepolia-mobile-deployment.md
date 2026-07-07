# Sepolia Mobile Wallet Deployment

This is the rehearsal path for the mobile wallet boilerplate. It deploys Loom
infrastructure to Sepolia without adding a Loom-operated service or a mutable
authority path.

## Inputs

Create a local environment file outside git:

```sh
SEPOLIA_RPC_URL=
SEPOLIA_DEPLOYER_PRIVATE_KEY=
SEPOLIA_ENTRYPOINT=
SEPOLIA_P256_FALLBACK_VERIFIER=
ETHERSCAN_API_KEY=
```

Rules:

- `SEPOLIA_DEPLOYER_PRIVATE_KEY` must fund only the rehearsal deployment.
- `SEPOLIA_ENTRYPOINT` must be the official ERC-4337 v0.9 EntryPoint for
  Sepolia and must have non-empty code.
- `SEPOLIA_P256_FALLBACK_VERIFIER` is required on Sepolia unless the target
  chain has independently verified P-256 precompile support.
- Do not commit RPC URLs, private keys, API keys, or unreduced operational
  notes.

## Deploy

```sh
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY"
```

The script deploys:

- account implementation;
- immutable account factory and per-app registry;
- policy and vault hooks;
- P-256, multi-P-256, ECDSA, exact-call session, and granular session
  validators;
- recovery manager;
- ECDSA, P-256, and ERC-1271 guardian verifiers.

## After Deploy

1. Record every deployed address, transaction hash, block number, constructor
   argument, and explorer verification URL.
2. Build a candidate manifest from the reviewed local config:

   ```sh
   npm run deployment:manifest:build -- \
     evidence/deployments/sepolia.config.local.json \
     evidence/deployments/sepolia.json
   npm run deployment:manifest:check -- evidence/deployments/sepolia.json
   ```

3. Configure the mobile app with the reviewed addresses:

   ```text
   EXPO_PUBLIC_LOOM_CHAIN_ID=11155111
   EXPO_PUBLIC_LOOM_L1_CHAIN_ID=11155111
   EXPO_PUBLIC_LOOM_ENTRYPOINT=<entrypoint>
   EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY=<factory>
   EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR=<p256-validator>
   EXPO_PUBLIC_LOOM_RPC_URL=<user-supplied rpc>
   EXPO_PUBLIC_LOOM_BUNDLER_URL=<user-supplied bundler>
   ```

4. Run mobile passkey registration and account deployment rehearsal on a real
   device.
5. Run two independent bundler qualification attempts before claiming Sepolia
   lifecycle support.

## Non-Goals

- This is not a production-funds deployment.
- This does not prove privacy transfers are production-enabled.
- This does not remove the need for browser/device passkey evidence.
- This does not replace the deployment manifest, explorer verification, or
  independent audit gates.

