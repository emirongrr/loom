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

## Sponsored onboarding

The page has two views. **Open an account** is what an institution's customer
sees: one button, one passkey prompt, no ETH, no transaction to approve. The
account is created on chain and the customer never learns that a chain was
involved. **Deployment & wallet** is the developer view — the bound deployment,
the derived address, and the individual register/reconnect/sign steps.

Gasless onboarding works because signing and paying are separate authorities:

```
browser                              sponsor backend
───────                              ───────────────
create passkey (biometric)
derive the account address
sign the creation operation  ─POST─▶  simulate, then pay
                                      depositTo + handleOps
                             ◀──────  { account, opTx }
```

The sponsor cannot alter the operation — any edit invalidates the user's
signature — and gains no authority over the account it paid to create. Creation
goes straight to the EntryPoint because the factory fail-closes to
`entryPoint.senderCreator()`, so no third-party bundler can validate initCode;
every later operation is ordinary bundler traffic.

Two caveats worth stating plainly: WebAuthn needs **two** biometric gestures
(creating a credential does not produce an assertion, and the first operation
must carry one), and `sponsor-server.mjs` is **unauthenticated** — as shipped it
pays for anyone who calls it, so put it behind your own user authentication.

## Running the page

`src/wallet.mjs` uses bare module specifiers, so the page is served through a
dev server. `dev.mjs` starts it, and starts the sponsor backend too when it is
configured:

```sh
npm --prefix examples/passkey-wallet-web run dev
```

The sponsor spends real funds, so it starts only when you supply both its
endpoint and its key — nothing selects a provider or a key for you. Copy the
template and fill it in:

```sh
cp examples/passkey-wallet-web/.env.example examples/passkey-wallet-web/.env
```

| Variable | Meaning |
| --- | --- |
| `SEPOLIA_RPC_URL` | the endpoint the sponsor reads and sends through |
| `SEPOLIA_SPONSOR_PRIVATE_KEY` | the key that **pays**, never account authority |
| `SPONSOR_PORT`, `SPONSOR_DEPOSIT_ETH` | optional; default `8787` and `0.02` |

`.env` is gitignored and `.env.example` carries no secret. Real environment
variables override the file, so an explicit export still wins. Use a throwaway
key holding only testnet funds: it cannot alter a signed operation or control an
account it funded, but it is still a spending key.

Without them the page still runs and the sponsor prints why it is absent; the
account stays counterfactual. To publish an operation from the command line
instead, `sponsor-deploy.mjs` takes a signed operation and does the same two
transactions — `--dry-run` simulates it without a key.

### Without a sponsor

An account can pay for its own creation. Send ETH to the counterfactual address
and the EntryPoint takes the prefund from that balance during validation; no
deposit and no paymaster are involved, and the operation needs no different
signature — `paymasterAndData` is already empty.

```sh
node examples/passkey-wallet-web/sponsor-deploy.mjs \
  --rpc-url … --op deploy-userop.json --no-deposit --dry-run
```

The dry run prints the maximum cost — `(verificationGasLimit + callGasLimit +
preVerificationGas) × maxFeePerGas`, all of them already fixed by the signature
— and whether the account holds enough. Someone still has to *send* the
transaction: creation cannot go through a public bundler, so a submitter fronts
the gas and is reimbursed as beneficiary. Self-funding changes who pays, not
whether a submitter exists.

Opened directly from the filesystem the deployment card still works — it is
plain DOM and JSON — while the wallet actions report that the runtime could not
be resolved rather than doing nothing. Use HTTPS or `localhost`: WebAuthn
requires a secure context and a real platform authenticator.

Loom is pre-audit software; this example is for evaluation, not production funds.
