import assert from "node:assert/strict";
import test from "node:test";
import {
  PrivacyAdapterFailureError,
  createAztecAdapterProfile,
  createConsentStore,
  createKohakuHost,
  createMemoryStorage,
  createProviderProfile,
  createRailgunAdapterProfile,
  providerConsentKey
} from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const bridge = "0x3333333333333333333333333333333333333333";

function hostFor(protocol, surfaces = ["rpc", "indexer", "relayer", "prover", "bridge", "timing"]) {
  const profile = createProviderProfile({
    mode: "user-rpc",
    chainId: 1,
    endpoint: "https://rpc.example",
    verified: false,
    metadataBudget: {
      protocol,
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
          reveals: `${protocol} local sync window`,
          required: true,
          mitigation: "incremental local checkpoints"
        },
        {
          surface: "relayer",
          reveals: `${protocol} operation submission timing`,
          required: false,
          mitigation: "optional user-selected relayer"
        },
        {
          surface: "prover",
          reveals: `${protocol} proving workload class`,
          required: false,
          mitigation: "local prover when available"
        },
        {
          surface: "bridge",
          reveals: `${protocol} public bridge interaction`,
          required: false,
          mitigation: "explicit bridge finality assumptions"
        }
      ]
    }
  });

  return createKohakuHost({
    providerProfile: profile,
    consentStore: createConsentStore([providerConsentKey(profile)]),
    metadataPolicy: { allowedSurfaces: surfaces, requireKnownMitigation: true },
    fetch: async () => new Response("{}")
  });
}

test("railgun sync failure is classified and does not checkpoint stale indexer state", async () => {
  const storage = createMemoryStorage();
  const railgun = await createRailgunAdapterProfile({
    host: hostFor("railgun"),
    storage,
    createPlugin: async () => ({
      async sync() {
        throw new Error("indexer unavailable");
      }
    })
  });
  const context = { account, chainId: 1, applicationId: "daily", scanScope: "payments" };

  await assert.rejects(railgun.sync(context), error => {
    assert.equal(error instanceof PrivacyAdapterFailureError, true);
    assert.equal(error.details.surface, "indexer");
    assert.equal(error.details.protocol, "railgun");
    return true;
  });

  assert.equal(railgun.scanState.get(context, "railgun"), null);
});

test("private broadcast relayer failure is surfaced without inventing fallback infrastructure", async () => {
  const railgun = await createRailgunAdapterProfile({
    host: hostFor("railgun"),
    createPlugin: async () => ({
      async broadcastPrivateOperation() {
        throw new Error("relayer rejected operation");
      }
    })
  });

  await assert.rejects(
    railgun.broadcastPrivateOperation({ account, chainId: 1 }, { kind: "private-transfer" }),
    error => {
      assert.equal(error instanceof PrivacyAdapterFailureError, true);
      assert.equal(error.details.surface, "relayer");
      assert.equal(error.details.recoverable, true);
      return true;
    }
  );
});

test("aztec profile builds private execution with bridge finality metadata", async () => {
  const aztec = await createAztecAdapterProfile({
    host: hostFor("aztec"),
    createPlugin: async () => ({
      async prepareTransfer(request) {
        return {
          calls: [
            {
              target: bridge,
              value: 0n,
              data: "0x1234"
            }
          ],
          operation: { kind: "aztec-private-transfer", recipient: request.recipient },
          requiresBridgeFinality: "l1-finalized-before-l2-private-settlement"
        };
      },
      async sync() {
        return {
          fromBlock: 100n,
          toBlock: 120n,
          latestMerkleRoot: "0xabcd"
        };
      }
    })
  });
  const context = { account, chainId: 1, applicationId: "vault", scanScope: "private-l2" };

  const operation = await aztec.privateTransfer({
    context,
    asset: token,
    amount: 10n,
    recipient: "aztec:recipient"
  });
  const state = await aztec.sync(context);

  assert.equal(operation.protocol, "aztec");
  assert.equal(operation.requiresBridgeFinality, "l1-finalized-before-l2-private-settlement");
  assert.equal(operation.calls[0].target, bridge);
  assert.equal(state.toBlock, "120");
  assert.equal(aztec.scanState.get(context, "aztec")?.latestMerkleRoot, "0xabcd");
});

test("aztec prover failure is classified before checkpoint mutation", async () => {
  const aztec = await createAztecAdapterProfile({
    host: hostFor("aztec"),
    createPlugin: async () => ({
      async prepareTransfer() {
        throw new Error("prover unavailable");
      }
    })
  });

  await assert.rejects(
    aztec.privateTransfer({
      context: { account, chainId: 1 },
      asset: token,
      amount: 10n,
      recipient: "aztec:recipient"
    }),
    error => {
      assert.equal(error instanceof PrivacyAdapterFailureError, true);
      assert.equal(error.details.surface, "prover");
      assert.equal(error.details.protocol, "aztec");
      return true;
    }
  );
});
