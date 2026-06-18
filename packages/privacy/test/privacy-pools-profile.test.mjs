import assert from "node:assert/strict";
import test from "node:test";
import {
  MetadataBudgetExceededError,
  createConsentStore,
  createKohakuHost,
  createMemoryStorage,
  createPrivacyPoolsAdapterProfile,
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
    protocol: "privacy-pool",
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
        reveals: "privacy-pool commitment sync window",
        required: true,
        mitigation: "incremental local checkpoints"
      },
      {
        surface: "prover",
        reveals: "proof generation availability and timing",
        required: true,
        mitigation: "user-selected prover or local prover"
      }
    ]
  }
};

function hostWithPolicy(policy = { allowedSurfaces: ["rpc", "indexer", "prover"], requireKnownMitigation: true }) {
  const profile = createProviderProfile(profileInput);
  return createKohakuHost({
    providerProfile: profile,
    consentStore: createConsentStore([providerConsentKey(profile)]),
    metadataPolicy: policy,
    fetch: async () => new Response("{}")
  });
}

test("privacy-pools profile initializes plugin without querying provider", async () => {
  let providerCalls = 0;
  let factoryCalls = 0;
  const profile = createProviderProfile(profileInput);
  const host = createKohakuHost({
    providerProfile: profile,
    consentStore: createConsentStore([providerConsentKey(profile)]),
    metadataPolicy: { allowedSurfaces: ["rpc", "indexer", "prover"], requireKnownMitigation: true },
    fetch: async () => {
      providerCalls += 1;
      return new Response("{}");
    }
  });

  const privacyPools = await createPrivacyPoolsAdapterProfile({
    host,
    config: { poolId: "test-pool" },
    createPlugin: async (receivedHost, config) => {
      factoryCalls += 1;
      assert.equal(receivedHost, host);
      assert.equal(config.poolId, "test-pool");
      return {
        async prepareTransfer() {
          return { operation: { kind: "privacy-pool-transfer" } };
        }
      };
    }
  });

  assert.equal(privacyPools.protocol, "privacy-pool");
  assert.equal(factoryCalls, 1);
  assert.equal(providerCalls, 0);
});

test("privacy-pools profile builds transfer through metadata-guarded adapter", async () => {
  const privacyPools = await createPrivacyPoolsAdapterProfile({
    host: hostWithPolicy(),
    createPlugin: async () => ({
      async prepareTransfer(request) {
        return {
          operation: { kind: "privacy-pool-transfer", recipient: request.recipient },
          calls: [
            {
              target: pool,
              value: 0n,
              data: "0x1234"
            }
          ],
          requiresVaultDelay: true
        };
      }
    })
  });

  const operation = await privacyPools.privateTransfer({
    context: { account, chainId: 1, applicationId: "merchant", scanScope: "payments" },
    asset: token,
    amount: 50n,
    recipient: "privacy-pool:recipient"
  });

  assert.equal(operation.protocol, "privacy-pool");
  assert.equal(operation.calls[0].target, pool);
  assert.equal(operation.operation.recipient, "privacy-pool:recipient");
  assert.equal(operation.requiresVaultDelay, true);
});

test("privacy-pools sync persists scoped local checkpoints", async () => {
  const storage = createMemoryStorage();
  const privacyPools = await createPrivacyPoolsAdapterProfile({
    host: hostWithPolicy(),
    storage,
    createPlugin: async () => ({
      async sync() {
        return {
          fromBlock: 100n,
          toBlock: 120n,
          latestMerkleRoot: "0xabcd"
        };
      }
    })
  });
  const context = { account, chainId: 1, applicationId: "daily", scanScope: "payments" };

  const state = await privacyPools.sync(context);

  assert.equal(state.fromBlock, "100");
  assert.equal(state.toBlock, "120");
  assert.equal(privacyPools.scanState.get(context, "privacy-pool")?.latestMerkleRoot, "0xabcd");
});

test("privacy-pools profile blocks sync before plugin execution when metadata policy rejects", async () => {
  let syncCalls = 0;
  const privacyPools = await createPrivacyPoolsAdapterProfile({
    host: hostWithPolicy({ allowedSurfaces: ["rpc", "indexer"], requireKnownMitigation: true }),
    createPlugin: async () => ({
      async sync() {
        syncCalls += 1;
        return { toBlock: 120n };
      }
    })
  });

  await assert.rejects(privacyPools.sync({ account, chainId: 1 }), MetadataBudgetExceededError);
  assert.equal(syncCalls, 0);
});
