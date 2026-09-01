# Passkey Wallet Sepolia Deployment

This runbook publishes the browser wallet contracts introduced by ADR-0027.
The deployment is immutable: a bad address cannot be repaired in place. A new
deployment and a reviewed manifest replacement are the rollback mechanism.

The process has three distinct authorities:

- the ephemeral deployer broadcasts bytecode but receives no wallet authority;
- two independently operated RPC endpoints attest to the resulting chain state;
- the wallet trusts only the reviewed manifest and the live validator key.

The app registry is a locator, never an authorization source.

Canonical release-evidence readiness and the distinction between the archived
historical broadcast and the next release candidate are tracked in
`docs/operations/sepolia-canonical-evidence-status.md`.

## Release gate

Do not broadcast from a working tree with uncommitted changes. Freeze the exact
release commit first, then build and test that commit with the pinned toolchain.
At minimum, require:

```sh
forge clean
forge build
forge test
npm run abi:check
npm run surface:check
npm run storage:check
npm run deployment:wallet:test
npm --prefix examples/passkey-wallet-web run typecheck
npm --prefix examples/passkey-wallet-web test
npm --prefix examples/passkey-wallet-web run build
git diff --check
git status --short
```

The final command must produce no output in the clean release checkout. Preserve
the commit hash and the command results with the deployment evidence.

## Secrets and endpoints

Use an ephemeral deployer key funded with only the Sepolia ETH needed for this
release. Do not place that key in the repository, the web app directory, shell
history, a manifest, or a Forge command argument. Supply it through the process
environment from a local secret store.

Required inputs:

```text
SEPOLIA_DEPLOYER_PRIVATE_KEY=<ephemeral testnet key>
SEPOLIA_RPC_URL=<broadcast and primary read endpoint>
SEPOLIA_VERIFICATION_RPC_URL=<different provider/operator>
SEPOLIA_ENTRYPOINT=0x433709009B8330FDa32311DF1C2AFA402eD8D009
SEPOLIA_SPONSORED_ONBOARDING=true
SEPOLIA_SPONSOR_AUTHORIZER=<address of a dedicated sponsorship-only key>
SEPOLIA_SPONSOR_POLICY_HASH=<keccak256 of the reviewed policy ID>
SEPOLIA_SPONSOR_MAX_COST_WEI=<per-activation on-chain ceiling>
SEPOLIA_SPONSOR_DEPOSIT_WEI=<initial EntryPoint paymaster deposit>
```

The two RPC URLs must be independently operated. Merely using two URLs for one
provider does not give independent evidence.

The sponsorship authorizer is not the deployer, relay submitter, or an account
validator. Keep all three keys distinct. The authorizer can approve bounded gas
payment only. The paymaster owner can withdraw sponsor funds but has no user
account authority.

`DeploySepolia.s.sol` refuses:

- a chain ID other than `11155111`;
- an EntryPoint address other than the official ERC-4337 v0.9 address;
- an EntryPoint runtime hash different from the reviewed pinned hash;
- an unexpected or missing v0.9 `SenderCreator`;
- inconsistent factory, implementation, EntryPoint, or registry bindings.

## Dry run

Build from the frozen commit and simulate the exact script before broadcasting:

```sh
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url "$SEPOLIA_RPC_URL" \
  -vvvv
```

Review the predicted deployer, nonce sequence, total gas, selected P-256 mode,
and every emitted address. The run must include `AppAccountRegistry` created by
`LoomAccountFactory`. When sponsored onboarding is enabled it must also include
`OnboardingPaymaster`, its constructor bindings, and the initial `deposit()` call.

## Broadcast

```sh
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast \
  --slow
```

Archive `broadcast/DeploySepolia.s.sol/11155111/run-latest.json` immediately.
If broadcasting is interrupted, inspect receipts and nonces before deciding
whether `--resume` is safe. Do not blindly start a fresh run: constructor-created
addresses depend on the deployer nonce sequence.

Explorer verification is a separate, auditable step. Pass API credentials only
through the environment and never write them into a URL committed as evidence.

## Build the wallet trust profile

After both RPC providers have reached the deployment block, run:

```sh
npm run deployment:passkey-wallet:connect -- \
  --broadcast broadcast/DeploySepolia.s.sol/11155111/run-latest.json \
  --rpc "$SEPOLIA_RPC_URL" \
  --verification-rpc "$SEPOLIA_VERIFICATION_RPC_URL" \
  --entrypoint "$SEPOLIA_ENTRYPOINT" \
  --onboarding sponsored \
  --sponsor-policy-id loom-sepolia-onboarding-v1 \
  --sponsor-authorizer "$SEPOLIA_SPONSOR_AUTHORIZER" \
  --sponsor-max-cost-wei "$SEPOLIA_SPONSOR_MAX_COST_WEI"
```

The connector reads addresses from the Foundry broadcast, reads bytecode and
immutable relationships independently from both RPCs, and writes
`examples/passkey-wallet-web/public/sepolia.deployment.json` only when the two
observations are identical. The replacement is staged in the same directory and
renamed atomically; disagreement leaves the existing manifest untouched.

The resulting profile must contain and pin all of these fields:

- `schemaVersion: 2`;
- `factory` and `runtimeCodeHashes.factory`;
- `appRegistry` and `runtimeCodeHashes.appRegistry`;
- `implementation`, EntryPoint, primary validator, and policy hook;
- recovery manager, intent board, guardian verifiers, and recovery provisioner;
- onboarding paymaster and `runtimeCodeHashes.onboardingPaymaster` when sponsored;
- sponsorship policy ID/hash, gas ceiling, quota window, private-only submission,
  and explicit fallback policy;
- proxy creation bytecode and the recovered-validator runtime hash with every
  immutable filled.

The connector also proves:

```text
factory.entryPoint()             == manifest.entryPoint
factory.accountImplementation()  == manifest.implementation
factory.registry()               == manifest.appRegistry
appRegistry.factory()            == manifest.factory
```

## Acceptance rehearsal

Before publishing the manifest to users, perform a clean-device rehearsal:

1. Qualify a private transaction endpoint distinct from both read RPCs. Record
   the provider policy/document hash and a canary proving the transaction was
   not visible in the public mempool before inclusion.
2. Create a new passkey. Confirm the app requests a second assertion only after
   paymaster authorization is returned.
3. Activate through the sponsored private path. Confirm the UserOperation names
   `OnboardingPaymaster`, the paymaster deposit is charged, the prospective
   account received no prefund, and public fallback was not used.
4. Confirm `accountForHandle(accountHandle)` and `handleForAccount(account)` agree
   through two independently operated RPCs.
5. On a clean second device, use the cloud-synced original passkey to resolve the
   same account and verify a fresh assertion against its live validator.
6. Register guardians, publish and approve a recovery intent, observe the full
   configured delay, and execute recovery to a second passkey.
7. On a clean browser/device, discover the same account with the recovery passkey.
8. Confirm the original passkey and old saved-wallet record fail closed because
   the old validator key is no longer live.
9. Send a small Sepolia transaction with the recovered passkey.

Write credential commitments, never credential IDs or private material, into a
local rehearsal file and validate it with:

```sh
npm run rehearsal:passkey-lifecycle:check -- evidence/rehearsals/<candidate>.json
```

Record transaction hashes, block numbers, device/browser versions, expected and
observed addresses, both RPC observations, and screenshots that contain no
credentials. Only then replace the deployment manifest in the release branch.

The sponsor service must use `SPONSOR_PRIVATE_RPC_URL`, distinct from
`SEPOLIA_RPC_URL`. The repository's in-memory reference server is deliberately
loopback-only. A production sponsor endpoint is a separate implementation: it
must authenticate a stable principal, use a durable transactional shared
quota/idempotency ledger, reserve budget before issuing an authorization, and
preserve outstanding authorizations across restarts.

## Rollback

Contracts are immutable and the registry binding is one-to-one. There is no
admin key and no in-place upgrade. If any verification or rehearsal fails:

1. stop distribution of the candidate manifest;
2. preserve the broadcast and failure evidence;
3. fix the source and create a new reviewed release commit;
4. deploy a fresh factory and registry;
5. repeat every gate from the beginning.

Never point a new manifest at a mixture of contracts from two deployments.
