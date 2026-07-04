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

## What each example shows

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

## Further reading

- [Enterprise integration guide](../docs/guides/enterprise-integration.md) — the
  architecture and trust boundaries behind `enterprise-onboarding.mjs`.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — the binding invariants these examples
  rely on.
