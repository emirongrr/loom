import assert from "node:assert/strict";
import test from "node:test";
import { createLoomClient } from "../src/index.js";
import { createKohakuHost } from "../../privacy/src/index.js";

// Walkaway example (executable): a Loom account's full authority lifecycle must
// run using only caller-supplied signer, broadcast transport, and privacy/runtime
// fetch. No Loom-operated RPC, bundler, paymaster, indexer, or recovery service
// may be contacted, and the SDK must never fall back to a hidden default provider.
// This mirrors the ARCHITECTURE.md core invariant "no mandatory Loom ...
// frontend" and the WalletBeat "custom endpoints, no default provider" criterion.

const account = "0x1111111111111111111111111111111111111111";
const factory = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const sessionKey = "0x4444444444444444444444444444444444444444";
const token = "0x5555555555555555555555555555555555555555";
const salt = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const configHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// A user-selected privacy provider profile (their own RPC endpoint, not a default).
const providerProfile = {
  mode: "user-rpc",
  chainId: 1,
  endpoint: "https://user-selected.rpc.example",
  verified: false,
  metadataBudget: {
    protocol: "railgun",
    chainId: 1,
    items: [
      {
        surface: "rpc",
        reveals: "target chain and request timing",
        required: true,
        mitigation: "user selected endpoint"
      }
    ]
  }
};

test("full account lifecycle runs through only caller-supplied adapters (walkaway)", async () => {
  const signed = [];
  const broadcast = [];
  const userFetchUrls = [];

  // Trap: fail loudly if the SDK performs any network I/O outside the injected
  // adapters. A walkaway-preserving SDK must never reach for global fetch itself.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    throw new Error(`walkaway violation: SDK made an unconfigured network call to ${String(input)}`);
  };

  try {
    const client = createLoomClient({
      chainId: 1,
      account,
      // Privacy/runtime access goes through the caller's own fetch + endpoint.
      kohaku: {
        host: createKohakuHost({
          providerProfile,
          fetch: async url => {
            userFetchUrls.push(String(url));
            return new Response("{}");
          }
        })
      },
      // Signing is the user's key material, never a Loom service.
      signer: {
        async signUserOperation(envelope) {
          signed.push(envelope);
          return "0xdeadbeef";
        }
      },
      // Broadcast is the user's chosen bundler/transport, never a Loom default.
      transport: {
        async sendUserOperation(envelope) {
          broadcast.push(envelope);
          return { userOpHash: `0x${"12".repeat(32)}` };
        }
      }
    });

    // 1. Deploy preparation is pure (no network): the user can build the deploy
    //    operation offline and publish it through any transport.
    const deploy = client.prepareDeployAccount({
      factory,
      salt,
      initCode: "0x1234",
      recoveryStatus: "unprotected"
    });
    assert.equal(deploy.intent.kind, "account.deploy");

    // 2. Operate: the call is signed by the injected signer and broadcast by the
    //    injected transport only.
    const sent = await client.sendCalls({ calls: [{ target, value: 0n, data: "0x1234" }] });
    assert.equal(sent.userOpHash, `0x${"12".repeat(32)}`);

    // 3. Grant a scoped session key (pure preparation, no network).
    const session = client.grantSession({
      origin: "https://app.example",
      sessionKey,
      target,
      selector: "0x12345678",
      token,
      maxAmount: 100n,
      validUntil: 200n,
      maxUses: 3
    });
    assert.equal(session.intent.kind, "session.grant");

    // 4. Propose guardian-threshold recovery (pure preparation, no network).
    const recovery = client.proposeRecovery({
      newConfigHash: configHash,
      configVersion: 2n,
      executeAfter: 1000n
    });
    assert.equal(recovery.intent.kind, "recovery.propose");
    assert.equal(recovery.review.requiresGuardianApproval, true);

    // 5. ERC-5792 atomic capability reporting is computed locally (no network).
    const capabilities = client.getCapabilities();
    assert.equal(capabilities["0x1"].atomic.status, "supported");

    // The only signing and broadcast paths used were the injected adapters.
    assert.equal(signed.length, 1, "exactly one operation signed, via the injected signer");
    assert.equal(broadcast.length, 1, "exactly one operation broadcast, via the injected transport");
    assert.equal(broadcast[0].userOperation.signature, "0xdeadbeef");
    assert.equal(broadcast[0].userOperation.sender, account);

    // Any provider access that did happen used the user's own endpoint.
    for (const url of userFetchUrls) {
      assert.equal(url.startsWith("https://user-selected.rpc.example"), true, `unexpected endpoint ${url}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("without a caller-supplied transport there is no fallback broadcast path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    throw new Error(`walkaway violation: SDK made an unconfigured network call to ${String(input)}`);
  };
  try {
    const client = createLoomClient({
      chainId: 1,
      account,
      kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
    });
    // Preparation still works offline...
    const prepared = client.prepareCalls({ calls: [{ target, value: 0n, data: "0x1234" }] });
    assert.equal(prepared.kind, "account.calls.prepare");
    // ...but broadcasting requires the user to supply signer + transport; the SDK
    // does not invent a default bundler.
    await assert.rejects(client.sendCalls({ calls: [{ target, value: 0n, data: "0x1234" }] }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
