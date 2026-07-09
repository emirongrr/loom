# Sepolia Mobile Wallet Deployment

This is the rehearsal path for the mobile wallet boilerplate. It deploys Loom
infrastructure to Sepolia without adding a Loom-operated service or a mutable
authority path.

## Inputs

Create a local environment file outside git:

```sh
# =============================================================================
# Required: Sepolia deployment
# =============================================================================

SEPOLIA_RPC_URL=
SEPOLIA_DEPLOYER_PRIVATE_KEY=
SEPOLIA_ENTRYPOINT=

# =============================================================================
# Optional: P-256 fallback verifier
# =============================================================================
# Only needed when the target chain does not support a canonical native P-256
# precompile, or when fallback mode is explicitly selected.
#
# Do not provide an arbitrary address here. Use a known audited verifier address
# and set its expected deployed bytecode hash, or let a future deployment script
# deploy an audited fallback implementation.
SEPOLIA_P256_FALLBACK_VERIFIER=
SEPOLIA_P256_FALLBACK_CODEHASH=

# =============================================================================
# Optional: explorer verification
# =============================================================================
# Only required when passing --verify to forge script.
ETHERSCAN_API_KEY=
```

Rules:

- `SEPOLIA_DEPLOYER_PRIVATE_KEY` must fund only the rehearsal deployment.
- `SEPOLIA_ENTRYPOINT` must be the official ERC-4337 v0.9 EntryPoint for
  Sepolia and must have non-empty code.
- Native P-256 precompile mode is the default for Sepolia and mainnet: the
  EIP-7951 precompile at 0x100 is recorded with probe evidence in
  `script/P256VerifierConfig.sol`, and the bootstrap pipeline re-probes the
  live chain (fresh signed vector via `eth_call`) before deploying. The native
  precompile is not a deployer-controlled contract.
- `SEPOLIA_P256_FALLBACK_VERIFIER` is only for chains without a working
  precompile.
- Fallback verifier mode uses a normal smart contract. It must be a known,
  audited verifier and `SEPOLIA_P256_FALLBACK_CODEHASH` must match its deployed
  bytecode hash. Arbitrary fallback verifier addresses are unsafe.
- `ETHERSCAN_API_KEY` is not required for deployment. It is only required when
  using `--verify`.
- Do not commit RPC URLs, private keys, API keys, or unreduced operational
  notes.

## Deploy

```sh
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast
```

Add `--verify --etherscan-api-key "$ETHERSCAN_API_KEY"` only when explorer
verification should run as part of the script command.

The script deploys:

- account implementation;
- immutable account factory and per-app registry;
- policy and vault hooks;
- P-256, multi-P-256, ECDSA, exact-call session, and granular session
  validators;
- recovery manager;
- ECDSA, P-256, and ERC-1271 guardian verifiers.

The script emits `P256VerifierSelected` with the full P-256 verifier provenance:

- `p256Verifier`;
- `p256VerifierMode`;
- `p256VerifierCodehash`;
- `p256NativePrecompileSupported`;
- `fallbackVerifierWasDeployed`;
- `fallbackVerifierWasProvided`.

The main deployment event also includes the selected verifier address, mode,
and code hash for manifest extraction.

For native precompile mode, `p256VerifierCodehash` is zero because a precompile
is a protocol-level primitive rather than normal account bytecode. For fallback
contract mode, the code hash must match the reviewed expected hash.

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
   EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE=<native-precompile|fallback-contract>
   EXPO_PUBLIC_LOOM_P256_VERIFIER=<selected-verifier>
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
