# passkey-wallet-web

A browser passkey wallet on Loom: **register** a passkey, derive the
counterfactual account, **reconnect** on a later visit, **sign** an operation,
and **grant/revoke** a scoped session — with no Loom-operated service and no
private key ever leaving the platform authenticator.

```sh
npm --prefix examples/passkey-wallet-web test   # the whole flow, deterministically
```

## How it is put together

- **`src/wallet.mjs`** is platform-neutral. It reaches WebAuthn only through an
  injected `credentials` provider:

  ```js
  credentials.create({ rpId, userName })
    // -> { credentialId, publicKeyX, publicKeyY }
  credentials.get({ credentialId, rpId, origin, challenge })
    // -> { authenticatorData, clientDataJSON, signature }
  ```

  That keeps the browser API at the edge and makes the whole flow testable.
- **`index.html`** supplies the only browser-specific code: the
  `navigator.credentials` wrapper. Registration reads the P-256 point from
  `getPublicKey()` (SPKI DER → `0x04 || x || y`); signing converts the wallet's
  base64url challenge back to bytes for `navigator.credentials.get`, so the
  `clientDataJSON` the authenticator echoes is exactly what the on-chain
  validator re-derives. The DER signature is normalized by `@loom/passkey`.
- **`test/wallet.test.mjs`** supplies a software P-256 authenticator, so
  register → reconnect → sign → session runs deterministically in CI.

## The packages it uses

| Package | Role |
| --- | --- |
| `@loom/core` | counterfactual address derivation, validator ABI |
| `@loom/passkey` | the engine-free WebAuthn signer and encoding |
| `@loom/sdk` | the account client, operation preparation, session builders |

Signing goes through `@loom/passkey`: the SDK client prepares an operation, the
canonical hash is computed, and the passkey signs *that hash*. Nothing about the
signer needs a bundler or a privacy runtime.

## What it demonstrates

- **Counterfactual onboarding** — the account address is derived locally from
  the passkey's public key; no chain call, no deployment, no funding required to
  know the address.
- **Reconnect without re-registration** — the persisted handle is public data
  only (credential id + public key); re-deriving reproduces the same address.
- **Hash-bound signing** — the authenticator signs the canonical EntryPoint
  hash carried as the WebAuthn challenge, which is what the account validates.
- **Bounded sessions** — a session key is granted with an explicit target,
  selector, token, amount, expiry, and use count, and revoked by key.

## Which deployment the wallet binds to

The page ships bound to **nothing**, and says so. A Loom account address is a
function of the deployment it is derived against, so a wallet that does not name
its deployment is not telling you what it is. The deployment card is therefore
always on screen: it shows a status pill (`not configured` / `incomplete` /
`configured`), the network by name and id (`Sepolia testnet (chainId 11155111)`),
and every address the derivation depends on.

Load one by pasting the JSON or picking a file. Both a flat object and a Loom
deployment manifest are accepted, and these fields are required:

| Field | Where it comes from |
| --- | --- |
| `chainId`, `entryPoint`, `factory`, `implementation`, `validator`, `policyHook` | your deployment manifest (`loom deploy inspect --manifest …`) |
| `proxyCreationCode` | the release artifact — **a manifest carries only its hash**, and the bytes are what local address derivation needs |

An incomplete document is reported field by field and still renders whatever
resolved, so a manifest missing `proxyCreationCode` will name its chain and
addresses while staying `incomplete`. Registration stays disabled until the
deployment is complete: the page will not derive an address it cannot stand
behind. Once bound, the wallet row reads `counterfactual on <network> — not
deployed until the first operation`.

## Running the page

`src/wallet.mjs` uses bare module specifiers, so serve the page through a
bundler or dev server that resolves `node_modules`:

```sh
npx vite examples/passkey-wallet-web
```

Opened directly from the filesystem the deployment card still works — it is
plain DOM and JSON — while the wallet actions report that the runtime could not
be resolved rather than doing nothing. Use HTTPS or `localhost`: WebAuthn
requires a secure context and a real platform authenticator.

Loom is pre-audit software; this example is for evaluation, not production funds.
