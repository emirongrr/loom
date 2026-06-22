import assert from "node:assert/strict";
import test from "node:test";
import {
  MetadataBudgetExceededError,
  createConsentStore,
  createKohakuHost,
  createMemoryStorage,
  createProviderProfile,
  createRailgunAdapterProfile,
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
      },
      {
        surface: "indexer",
        reveals: "private note sync window",
        required: true,
        mitigation: "incremental local checkpoints"
      }
    ]
  }
};

function hostWithPolicy(policy = { allowedSurfaces: ["rpc", "indexer"], requireKnownMitigation: true }) {
  const profile = createProviderProfile(profileInput);
  return createKohakuHost({
    providerProfile: profile,
    consentStore: createConsentStore([providerConsentKey(profile)]),
    metadataPolicy: policy,
    fetch: async () => new Response("{}")
  });
}

test("railgun profile initializes plugin with host and config without querying provider", async () => {
  let providerCalls = 0;
  let factoryCalls = 0;
  const profile = createProviderProfile(profileInput);
  const host = createKohakuHost({
    providerProfile: profile,
    consentStore: createConsentStore([providerConsentKey(profile)]),
    metadataPolicy: { allowedSurfaces: ["rpc", "indexer"], requireKnownMitigation: true },
    fetch: async () => {
      providerCalls += 1;
      return new Response("{}");
    }
  });

  const railgun = await createRailgunAdapterProfile({
    host,
    config: { databaseName: "loom-test" },
    createPlugin: async (receivedHost, config) => {
      factoryCalls += 1;
      assert.equal(receivedHost, host);
      assert.equal(config.databaseName, "loom-test");
      return {
        async prepareTransfer() {
          return { operation: { kind: "private-transfer" } };
        }
      };
    }
  });

  assert.equal(railgun.protocol, "railgun");
  assert.equal(factoryCalls, 1);
  assert.equal(providerCalls, 0);
});

test("railgun profile builds private transfer through the shared metadata-guarded adapter", async () => {
  const railgun = await createRailgunAdapterProfile({
    host: hostWithPolicy(),
    createPlugin: async () => ({
      async prepareTransfer(request) {
        return {
          operation: { kind: "private-transfer", recipient: request.recipient },
          calls: [
            {
              target: pool,
              value: 0n,
              data: "0x1234"
            }
          ]
        };
      }
    })
  });

  const operation = await railgun.privateTransfer({
    context: { account, chainId: 1, applicationId: "merchant", scanScope: "payments" },
    asset: token,
    amount: 50n,
    recipient: "railgun:recipient"
  });

  assert.equal(operation.protocol, "railgun");
  assert.equal(operation.calls[0].target, pool);
  assert.equal(operation.operation.recipient, "railgun:recipient");
});

test("railgun profile supports upstream Kohaku Railgun plugin method signatures", async () => {
  const calls = [];
  const railgun = await createRailgunAdapterProfile({
    host: hostWithPolicy(),
    createPlugin: async () => ({
      async instanceId() {
        calls.push(["instanceId"]);
        return "0zkloom";
      },
      async prepareShield(asset, recipient) {
        calls.push(["prepareShield", asset, recipient]);
        return [
          {
            to: pool,
            value: 0n,
            data: "0x1234"
          }
        ];
      },
      async prepareTransfer(asset, recipient) {
        calls.push(["prepareTransfer", asset, recipient]);
        return {
          __type: "privateOperation",
          railgunTxid: "private-transfer"
        };
      },
      async prepareUnshield(asset, recipient) {
        calls.push(["prepareUnshield", asset, recipient]);
        return {
          __type: "privateOperation",
          railgunTxid: "unshield"
        };
      },
      async broadcast(operation) {
        calls.push(["broadcast", operation]);
        return { status: "broadcast" };
      }
    })
  });

  const context = { account, chainId: 1, applicationId: "merchant", scanScope: "payments" };
  const created = await railgun.createAccount(context);
  const shield = await railgun.shield({ context, asset: token, amount: 10n, recipient: "0zkloom" });
  const transfer = await railgun.privateTransfer({ context, asset: token, amount: 5n, recipient: "0zkrecipient" });
  const unshield = await railgun.unshield({ context, asset: token, amount: 3n, recipient: account });
  const broadcast = await railgun.broadcastPrivateOperation(context, transfer.operation);

  assert.equal(created.shieldedAddress, "0zkloom");
  assert.equal(shield.calls[0].target, pool);
  assert.equal(shield.calls[0].data, "0x1234");
  assert.equal(transfer.operation.railgunTxid, "private-transfer");
  assert.equal(unshield.operation.railgunTxid, "unshield");
  assert.equal(unshield.requiresVaultDelay, true);
  assert.deepEqual(broadcast.result, { status: "broadcast" });
  assert.deepEqual(calls[1][1], {
    asset: {
      __type: "erc20",
      contract: token
    },
    amount: 10n
  });
});

test("railgun profile rejects non-Railgun private transfer recipients for upstream plugin", async () => {
  const railgun = await createRailgunAdapterProfile({
    host: hostWithPolicy(),
    createPlugin: async () => ({
      async instanceId() {
        return "0zkloom";
      },
      async prepareTransfer() {
        throw new Error("should not be called");
      }
    })
  });

  await assert.rejects(
    railgun.privateTransfer({
      context: { account, chainId: 1 },
      asset: token,
      amount: 1n,
      recipient: account
    }),
    error => {
      assert.equal(error.name, "PrivacyAdapterFailureError");
      assert.match(error.details.cause, /Railgun address/);
      return true;
    }
  );
});

test("railgun balance normalizes erc20 assets and preserves metadata budget", async () => {
  const railgun = await createRailgunAdapterProfile({
    host: hostWithPolicy(),
    createPlugin: async () => ({
      async balance() {
        return [
          {
            asset: `erc20:${token}`,
            amount: 123n,
            verified: true
          }
        ];
      }
    })
  });

  const balances = await railgun.balance({ account, chainId: 1 });

  assert.equal(balances.length, 1);
  assert.equal(balances[0].asset, token);
  assert.equal(balances[0].amount, 123n);
  assert.equal(balances[0].verified, true);
  assert.equal(balances[0].metadataBudget.items.length, 2);
});

test("railgun sync persists scoped local checkpoints after metadata approval", async () => {
  const storage = createMemoryStorage();
  const railgun = await createRailgunAdapterProfile({
    host: hostWithPolicy(),
    storage,
    createPlugin: async () => ({
      async sync() {
        return {
          fromBlock: 10n,
          toBlock: 20n,
          latestMerkleRoot: "0x1234"
        };
      }
    })
  });
  const context = { account, chainId: 1, applicationId: "daily", scanScope: "payments" };

  const state = await railgun.sync(context);

  assert.equal(state.toBlock, "20");
  assert.equal(railgun.scanState.get(context, "railgun")?.latestMerkleRoot, "0x1234");
});

test("railgun profile blocks indexer sync before plugin execution when metadata policy rejects", async () => {
  let syncCalls = 0;
  const railgun = await createRailgunAdapterProfile({
    host: hostWithPolicy({ allowedSurfaces: ["rpc"], requireKnownMitigation: true }),
    createPlugin: async () => ({
      async sync() {
        syncCalls += 1;
        return { toBlock: 20n };
      }
    })
  });

  await assert.rejects(railgun.sync({ account, chainId: 1 }), MetadataBudgetExceededError);
  assert.equal(syncCalls, 0);
});
