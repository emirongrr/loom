# @loom/passkey

The platform-neutral passkey surface for Loom accounts. A browser or mobile
wallet needs to turn a WebAuthn assertion into the exact signature a Loom
account validates, and to know the shape of the passkey provider it must
implement — **without** the wallet engine (bundler transport, state transport,
privacy runtime). This package is that surface, and it depends only on
`@loom/core`.

## What it gives you

- **The canonical WebAuthn/P-256 encoding**, re-exported so a passkey consumer
  imports it from one place: `encodeWebAuthnSignature`, `encodeValidatorSignature`,
  `parseP256Signature` (raw64 or DER, normalized to low-s), `base64UrlEncode`.
- **The provider contract**: `PasskeyProvider`, `PasskeyChallenge`,
  `PasskeyAssertion` — the interface a platform authenticator module implements.
- **`encodeWebAuthnValidatorSignature`** — encode a raw assertion into the
  account-level `(validator, WebAuthnSignature)` envelope.
- **`createWebAuthnSigner`** — a minimal, engine-free signer: you compute the
  canonical user-operation hash (with `getUserOpHash` from `@loom/core`) and it
  drives the provider and returns the account-ready signature.

## Example

```ts
import { getUserOpHash, packUserOperation } from '@loom/core'
import { createWebAuthnSigner } from '@loom/passkey'

const signer = createWebAuthnSigner({
  validator: '0x…',          // the installed P-256 validator
  origin: 'https://wallet.example',
  rpId: 'wallet.example',
  async signChallenge(challenge) {
    // challenge.challenge is base64url(userOperationHash) — hand it to the
    // platform authenticator and return its raw assertion.
    return navigatorCredentialsGet(challenge)
  },
})

const hash = getUserOpHash(packUserOperation(userOp), entryPoint, chainId)
userOp.signature = await signer.sign(hash) // (validator, WebAuthnSignature)
```

No bundler, no transport, no privacy runtime — everything a browser or mobile
wallet needs to sign, and nothing it doesn't. The wallet engine's
`createPasskeySigner` (in `@loom/sdk`) is the higher-level equivalent that also
builds and submits the operation.
