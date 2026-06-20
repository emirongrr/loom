# @loom/sdk

`@loom/sdk` is the local wallet-engine surface for Loom integrators. It joins
the account lifecycle builders with the Kohaku-compatible privacy runtime
without introducing a required Loom server, RPC, relayer, paymaster, indexer,
or catalog.

The package is intentionally narrow:

- it builds local lifecycle intents;
- it creates a Kohaku-compatible host only from explicit provider input;
- it scopes dapp activity locally instead of publishing a global account graph;
- it binds private operations to vault withdrawals by hash;
- it gives wallet clients a clear-signing review object for user display.

The SDK does not broadcast transactions, choose a default provider, or claim
that any privacy protocol is available unless the caller supplies a concrete
adapter.

## Example

```js
import {
  createBundlerTransport,
  createLoomClient,
  createPasskeySigner
} from "@loom/sdk";

const wallet = createLoomClient({
  chainId: 1,
  account: "0x1111111111111111111111111111111111111111",
  kohaku: {
    providerProfile: {
      mode: "user-rpc",
      chainId: 1,
      endpoint: "https://rpc.example",
      verified: false,
      metadataBudget: {
        protocol: "railgun",
        chainId: 1,
        items: [
          {
            surface: "rpc",
            reveals: "target chain and request timing",
            required: true,
            mitigation: "user-selected endpoint"
          }
        ]
      }
    }
  }
});

const session = wallet.grantSession({
  origin: "https://app.example",
  sessionKey: "0x2222222222222222222222222222222222222222",
  target: "0x3333333333333333333333333333333333333333",
  selector: "0x12345678",
  token: "0x4444444444444444444444444444444444444444",
  maxAmount: 1000000n,
  validUntil: 2000000000n,
  maxUses: 3
});
```

Broadcasting requires caller-supplied signer and transport adapters:

```js
await wallet.sendCalls(
  {
    calls: [
      {
        target: "0x3333333333333333333333333333333333333333",
        value: 0n,
        data: "0x1234"
      }
    ]
  },
  {
    signer: createPasskeySigner({
      credentialId: "local-credential-id",
      rpId: "wallet.example",
      signChallenge: walletPasskeyPrompt
    }),
    transport: createBundlerTransport({
      endpoint: "https://bundler.example",
      entryPoint: "0x3333333333333333333333333333333333333333"
    })
  }
);
```

For flows that want a one-call developer experience, use the receipt helper.
It still depends on the caller-supplied transport:

```js
const { receipt } = await wallet.sendCallsAndWait(
  {
    calls: [
      {
        target: "0x3333333333333333333333333333333333333333",
        value: 0n,
        data: "0x1234"
      }
    ]
  },
  {
    signer,
    transport,
    timeoutMs: 60000
  }
);
```

Future wallet clients can layer UI, simulations, signing devices, and concrete
Kohaku privacy plugins on top of this boundary.
