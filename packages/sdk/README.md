# @loom/sdk

`@loom/sdk` is the local wallet-engine surface for Loom integrators. It joins
the account lifecycle builders with the Kohaku-compatible privacy runtime
without introducing a required Loom server, RPC, relayer, paymaster, indexer,
or catalog.

The package is intentionally narrow:

- it builds local lifecycle intents;
- it exposes typed lifecycle calldata encoders;
- it creates a Kohaku-compatible host only from explicit provider input;
- it scopes dapp activity locally instead of publishing a global account graph;
- it binds private operations to vault withdrawals by hash;
- it gives wallet clients a clear-signing review object for user display;
- it exposes ERC-5792 Wallet Call capability reporting and request builders
  without claiming unsupported infrastructure.

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

Passkey-only onboarding can prepare an account before guardians are available,
but the review object must be shown to the user as unprotected recovery:

```js
const deploy = wallet.prepareDeployAccount({
  factory: "0x5555555555555555555555555555555555555555",
  salt: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  initCode: "0x1234",
  recoveryStatus: "unprotected"
});

console.log(deploy.review.summary);
```

Typed encoders are exposed without adding a provider dependency:

```js
const data = wallet.sdk.encoders.account.revokeTokenAllowance({
  token: "0x4444444444444444444444444444444444444444",
  spender: "0x3333333333333333333333333333333333333333"
});

const viemCalls = wallet.toViemCalls(
  wallet.prepareCalls({
    calls: [{ target: wallet.account, value: 0n, data }]
  })
);
```

ERC-5792 capability reporting is truthful and local. Loom reports atomic batch
support only for the enabled account and chain; unsupported chains are omitted
instead of producing an optimistic capability.

```js
const capabilities = wallet.getCapabilities({
  address: wallet.account,
  chainIds: ["0x1", "0x2105"]
});

const request = wallet.prepareWalletSendCalls({
  version: "2.0.0",
  id: "app-request-1",
  from: wallet.account,
  chainId: "0x1",
  atomicRequired: true,
  calls: [
    {
      to: "0x3333333333333333333333333333333333333333",
      value: "0x0",
      data: "0x1234"
    }
  ],
  capabilities: {
    paymasterService: { optional: true }
  }
});

console.log(capabilities["0x1"].atomic.status); // "supported"
console.log(request.review.summary);
```

Unsupported non-optional capabilities are rejected before signing. Optional
capabilities are ignored unless a caller supplies a reviewed adapter that
implements them.

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
