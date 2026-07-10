# End-to-End Devnet Lifecycle

`npm run e2e:devnet` runs Loom end to end against a throwaway local devnet,
using contracts only — no app, no bundler, and no SDK in the account path. It
is the black-box counterpart to the unit and integration suites: those test
components in isolation; this proves the deployed system works together.

## What it does

The orchestrator (`tools/e2e/devnet-lifecycle.mjs`):

1. Starts a fresh `anvil` devnet and tears it down afterwards.
2. Probes the live EIP-7951 P-256 precompile with a freshly signed vector, so
   native P-256 mode is evidence-backed on the node exactly as production
   requires for Sepolia and mainnet.
3. Deploys the full Loom stack with `script/DeployDevnet.s.sol` (real
   broadcast): EntryPoint, account implementation, immutable factory and
   registry, policy and vault hooks, the P-256, ECDSA, and session validators,
   and the recovery manager.
4. Verifies the deployment with the `@loom/deployment` toolkit: parses the
   Foundry broadcast, reads live bytecode from the chain, and confirms every
   app-required contract has code.
5. Runs `script/DevnetAccountLifecycle.s.sol`, which drives the real
   production path — `EntryPoint.handleOps` → factory `initCode` →
   `P256Validator` WebAuthn verification → account execution — using a software
   P-256 key. The WebAuthn envelope is byte-identical to a platform passkey, so
   the contracts cannot tell it apart from a device authenticator. It creates a
   `LoomAccount`, executes a call, then executes a second call on the deployed
   account, asserting on-chain state after each.

The software P-256 key is a devnet convenience: it lets CI exercise the passkey
path without a hardware authenticator. It is not a substitute for device
passkey evidence (see `examples/mobile-privacy-wallet/GAPS.md` G-001).

## CI

The `Build and test` job in `.github/workflows/ci.yml` runs `npm run e2e:devnet`
after the contract and SDK checks. `anvil` and `forge` come from the Foundry
toolchain the job already installs.
