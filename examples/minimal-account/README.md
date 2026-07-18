# Minimal account (clean-room)

The smallest end-to-end Loom integration, written the way an external developer
would write it: an empty project that installs `@loom/core` and `@loom/sdk`
from packed tarballs and never imports a repository path.

The script generates a software P-256 passkey, derives the counterfactual
account address locally (cross-checked against the live factory), deploys the
account and executes a call through the real EntryPoint with a passkey
signature over the canonical user-operation hash, then sends a second
operation using the nonce read through the public state transport.

Run the whole proof — pack, clean-room install, devnet, execute — with:

```sh
npm run e2e:clean-room
```

The runner (`tools/e2e/clean-room-minimal-account.mjs`) statically rejects any
repository-path import in this example before running it, so the example can
never quietly depend on repo internals. [`index.mjs`](index.mjs) is the whole
integration.
