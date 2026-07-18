import assert from "node:assert/strict";
import test from "node:test";
import {
  MetadataBudgetExceededError,
  PrivacyAdapterUnavailableError,
  createConsentStore,
  createKohakuHost,
  createKohakuShieldedPoolAdapter,
  createMemoryStorage,
  createPrivateScanStateStore,
  createProviderProfile,
  providerConsentKey
} from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const pool = "0x3333333333333333333333333333333333333333";

const profileInput = {
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
        reveals: "selected chain and request timing",
        required: true,
        mitigation: "user-selected endpoint"
      }
    ]
  }
};

function hostWithPolicy(policy = { allowedSurfaces: ["rpc"], requireKnownMitigation: true }) {
  const profile = createProviderProfile(profileInput);
  return createKohakuHost({
    providerProfile: profile,
    consentStore: createConsentStore([providerConsentKey(profile)]),
    metadataPolicy: policy,
    fetch: async () => new Response("{}")
  });
}

test("shielded pool adapter construction does not touch provider or plugin", () => {
  let providerCalls = 0;
  let pluginCalls = 0;
  const profile = createProviderProfile(profileInput);
  const host = createKohakuHost({
    providerProfile: profile,
    consentStore: createConsentStore([providerConsentKey(profile)]),
    fetch: async () => {
      providerCalls += 1;
      return new Response("{}");
    }
  });

  createKohakuShieldedPoolAdapter({
    host,
    plugin: {
      prepareTransfer() {
        pluginCalls += 1;
        return {};
      }
    }
  });

  assert.equal(providerCalls, 0);
  assert.equal(pluginCalls, 0);
});

test("adapter checks metadata budget before invoking privacy plugin", async () => {
  let pluginCalls = 0;
  const host = createKohakuHost({
    providerProfile: {
      ...profileInput,
      metadataBudget: {
        protocol: "railgun",
        chainId: 1,
        items: [
          {
            surface: "relayer",
            reveals: "private operation submission timing",
            required: true,
            mitigation: "optional user-selected relayer"
          }
        ]
      }
    },
    metadataPolicy: {
      allowedSurfaces: ["rpc"]
    },
    fetch: async () => new Response("{}")
  });
  const adapter = createKohakuShieldedPoolAdapter({
    host,
    plugin: {
      prepareShield() {
        pluginCalls += 1;
        return {};
      }
    }
  });

  await assert.rejects(
    adapter.shield({
      context: { account, chainId: 1 },
      asset: token,
      amount: 10n
    }),
    MetadataBudgetExceededError
  );
  assert.equal(pluginCalls, 0);
});

test("adapter normalizes explicit public calls returned by a Kohaku-style plugin", async () => {
  const adapter = createKohakuShieldedPoolAdapter({
    host: hostWithPolicy(),
    plugin: {
      async prepareShield(request) {
        return {
          calls: [
            {
              target: pool,
              value: 0n,
              data: "0x1234"
            }
          ],
          operation: {
            asset: request.asset,
            amount: request.amount?.toString()
          },
          requiresVaultDelay: true
        };
      }
    }
  });

  const operation = await adapter.shield({
    context: { account, chainId: 1, applicationId: "pay", scanScope: "daily" },
    asset: token,
    amount: 10n
  });

  assert.equal(operation.protocol, "railgun");
  assert.equal(operation.chainId, 1);
  assert.equal(operation.requiresVaultDelay, true);
  assert.equal(operation.calls.length, 1);
  assert.deepEqual(operation.calls[0], {
    target: pool,
    value: 0n,
    data: "0x1234"
  });
  assert.equal(operation.metadataBudget.items[0].surface, "rpc");
});

test("adapter reports unavailable broadcast without inventing a relayer", async () => {
  const adapter = createKohakuShieldedPoolAdapter({
    host: hostWithPolicy(),
    plugin: {
      async prepareTransfer() {
        return { operation: { kind: "private-transfer" } };
      }
    }
  });

  await assert.rejects(
    adapter.broadcastPrivateOperation({ account, chainId: 1 }, { kind: "private-transfer" }),
    PrivacyAdapterUnavailableError
  );
});

test("private scan state is scoped by account application and scan scope", () => {
  const storage = createMemoryStorage();
  const scanState = createPrivateScanStateStore(storage);
  const dailyContext = { account, chainId: 1, applicationId: "daily", scanScope: "payments" };
  const vaultContext = { account, chainId: 1, applicationId: "vault", scanScope: "savings" };

  scanState.set(dailyContext, "railgun", {
    fromBlock: 10n,
    toBlock: 20n,
    latestMerkleRoot: "0x1234"
  });

  assert.equal(scanState.get(dailyContext, "railgun")?.toBlock, "20");
  assert.equal(scanState.get(vaultContext, "railgun"), null);
  assert.notEqual(scanState.key(dailyContext, "railgun"), scanState.key(vaultContext, "railgun"));
});

// The private-flow wallet surface is canonically imported from THIS package;
// the wallet engine keeps the runtime but privacy owns the supported entry
// point. This exercises the re-exported preparation end to end with an
// adapter, proving the layering (privacy -> sdk) actually resolves and runs.
test("canonical private-flow surface is importable and works from @loom/privacy", async () => {
  const { createKohakuRuntime, preparePrivateVaultWithdrawal } = await import("../src/index.js");
  assert.equal(typeof createKohakuRuntime, "function");
  assert.equal(typeof preparePrivateVaultWithdrawal, "function");

  const account = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const budget = {
    protocol: "railgun",
    chainId: 1,
    items: [{ surface: "rpc", reveals: "chain and timing", required: true, mitigation: "user endpoint" }]
  };
  const prepared = await preparePrivateVaultWithdrawal({
    adapter: {
      protocol: "railgun",
      async metadataBudget() {
        return budget;
      },
      async privateTransfer(request) {
        return this.buildOperation(request);
      },
      async buildOperation(request) {
        return {
          protocol: "railgun",
          chainId: request.context.chainId,
          calls: [{ target: token, value: 0n, data: "0x1234" }],
          metadataBudget: budget,
          operation: { kind: "private-transfer", applicationId: request.context.applicationId, amount: "100" },
          requiresVaultDelay: true
        };
      }
    },
    context: { account, chainId: 1 },
    vault: {
      token,
      recipient: "0x3333333333333333333333333333333333333333",
      amount: 100n,
      executeAfter: 1000n
    }
  });

  assert.equal(prepared.intent.kind, "vault.privateWithdrawal.schedule");
  assert.equal(prepared.intent.privacyProtocol, "railgun");
});
