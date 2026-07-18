# Loom Examples

Runnable scripts that show how to build a client on top of the Loom SDK without
depending on any Loom-operated service. Each script is self-verifying
(`node:assert`) and narrates its steps, so running it reads like the flow it
documents.

These examples install a global-`fetch` trap: if the SDK ever reached for a
hidden default provider, the script would fail loudly. That is the same
"walkaway" guarantee the SDK test suite enforces — the wallet keeps working with
only the adapters you supply.

## Running

From the repository root, after `npm ci`:

```sh
node examples/enterprise-onboarding.mjs
node examples/individual-passkey-wallet.mjs
```

No network access, no extra dependencies. The scripts import the workspace
packages directly from `packages/`.

The clean-room proof is separate: `minimal-account/` never imports repository
paths, and its runner packs the SDK, installs the tarballs into an empty
project, and executes the whole lifecycle against a live devnet:

```sh
npm run e2e:clean-room
```

## Mobile app boilerplate

`mobile-privacy-wallet/` is a production-oriented Expo Dev Client template for
teams that want to build an iOS/Android wallet on Loom. Unlike the Node
examples, it is a mobile workspace with explicit native, store-readiness, and
privacy gates. Runtime wallet flows do not use mocks: if a passkey module,
RPC, bundler, guardian ceremony, deployment manifest, or Railgun evidence is
missing, the corresponding feature is disabled and reported in
`mobile-privacy-wallet/GAPS.md`.

## What each example shows

### `minimal-account/`

The smallest external integration, run clean-room from packed `@loom/core` and
`@loom/sdk` tarballs: generate a P-256 passkey, derive the account address
locally (chain-confirmed), deploy and operate through the real EntryPoint with
passkey signatures over the canonical hash, then send a second operation with
the nonce read through the public state transport. See
[`minimal-account/README.md`](minimal-account/README.md).

### `backend-userop-tracker/`

A framework-neutral backend that tracks UserOperations from chain logs: decodes
EntryPoint and factory events with the `@loom/core` ABIs, tracks each operation
through idempotent `submitted → included → finalized` transitions with a
finality policy, and survives reorgs, duplicates, replacement, and provider
disagreement. It holds no keys and picks no framework — logs and head numbers in,
webhook-shaped events and metrics out. The `e2e:bundler-devnet` proof replays
the live devnet's real EntryPoint logs through it. See
[`backend-userop-tracker/README.md`](backend-userop-tracker/README.md).

### `enterprise-onboarding.mjs`

A fintech ("Acme Pay") embeds a self-custody wallet into its own product. The
user only ever sees Acme's UI. The example demonstrates the division of
responsibility that makes this faithful to Loom's model:

- **The institution owns the experience**: onboarding, KYC, fiat rails, and the
  RPC/bundler infrastructure. KYC is off-chain and never touches the Loom core.
- **The user owns authority**: a WebAuthn passkey signs operations; Acme's
  bundler only broadcasts them and can neither sign nor forge.
- **The account is self-sovereign**: it is counterfactual (fundable before
  deploy), guardian-protected from day one (Acme is not a guardian), and
  controllable even if Acme disappears.
- **Metrics stay private**: Acme reads its own `AppAccountRegistry` cohort for
  wallet counts and TVL scoping — per-institution, never a global registry, and
  never linking a user's accounts (see `docs/decisions/0009-app-account-registry.md`).

### `individual-passkey-wallet.mjs`

The same core, driven by one person with no company behind them: a passkey
wallet plus self-chosen guardian social recovery, built and verified
client-side with `@loom/guardian`. It shows that the institutional and
individual experiences are the same engine, not two codebases.

## Planned examples

The examples aim to cover four product archetypes on the same account. Two are
implemented; two are tracked here so they can be built incrementally, following
the same conventions: self-verifying `node:assert` steps, a global-`fetch`
trap, and no Loom-operated service.

- [x] **Embedded fintech** — `enterprise-onboarding.mjs`.
- [x] **Consumer wallet** — `individual-passkey-wallet.mjs`.
- [ ] **Enterprise integration** — extend the fintech flow with institutional
      operations workflows: scheduled/timelocked treasury calls, policy-hook
      spending limits for operators, and guardian oversight, while the user's
      passkey keeps account authority throughout.
- [ ] **Custom authorization** — compose `ExactCallSessionValidator`, granular
      session permissions, and a spending-policy hook into an
      application-specific security model, e.g. a narrowly scoped autonomous
      agent or a subscription payment flow with revocable, bounded permissions.

## Further reading

- [Enterprise integration guide](../docs/guides/enterprise-integration.md) — the
  architecture and trust boundaries behind `enterprise-onboarding.mjs`.
- [`docs/design/architecture.md`](../docs/design/architecture.md) — the
  architecture and invariants these examples rely on.
