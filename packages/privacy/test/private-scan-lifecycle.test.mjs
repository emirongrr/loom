import assert from "node:assert/strict";
import test from "node:test";
import {
  PrivateScanStateError,
  createMemoryStorage,
  createPrivateScanLifecycle,
  createPrivateScanStateStore
} from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const context = { account, chainId: 1, applicationId: "daily", scanScope: "payments" };

test("private scan lifecycle reports missing state before local sync", () => {
  const lifecycle = createPrivateScanLifecycle({
    storage: createMemoryStorage(),
    now: () => 1000
  });

  const result = lifecycle.read(context);

  assert.equal(result.status, "missing");
  assert.equal(result.state, null);
  assert.throws(() => lifecycle.requireFresh(context), PrivateScanStateError);
});

test("private scan lifecycle checkpoints fresh local state", () => {
  const lifecycle = createPrivateScanLifecycle({
    storage: createMemoryStorage(),
    staleAfterMs: 5000,
    now: () => 1000
  });

  const state = lifecycle.checkpoint(context, {
    fromBlock: 10n,
    toBlock: 20n,
    latestMerkleRoot: "0x1234"
  });
  const result = lifecycle.read(context);

  assert.equal(state.updatedAt, 1000);
  assert.equal(result.status, "fresh");
  assert.equal(result.ageMs, 0);
  assert.equal(lifecycle.requireFresh(context).toBlock, "20");
});

test("private scan lifecycle marks stale checkpoints explicitly", () => {
  let time = 1000;
  const lifecycle = createPrivateScanLifecycle({
    storage: createMemoryStorage(),
    staleAfterMs: 5000,
    now: () => time
  });

  lifecycle.checkpoint(context, { toBlock: 20n });
  time = 7001;

  const result = lifecycle.read(context);

  assert.equal(result.status, "stale");
  assert.equal(result.ageMs, 6001);
  assert.throws(() => lifecycle.requireFresh(context), PrivateScanStateError);
});

test("private scan lifecycle reset removes only the scoped checkpoint", () => {
  const storage = createMemoryStorage();
  const store = createPrivateScanStateStore(storage);
  const lifecycle = createPrivateScanLifecycle({ store, now: () => 1000 });
  const vaultContext = { account, chainId: 1, applicationId: "vault", scanScope: "savings" };

  lifecycle.checkpoint(context, { toBlock: 20n });
  lifecycle.checkpoint(vaultContext, { toBlock: 30n });
  lifecycle.reset(context);

  assert.equal(lifecycle.read(context).status, "missing");
  assert.equal(lifecycle.read(vaultContext).status, "fresh");
});

test("private scan reset fails closed when storage cannot delete", () => {
  const lifecycle = createPrivateScanLifecycle({
    storage: {
      set() {},
      get() {
        return null;
      }
    }
  });

  assert.throws(() => lifecycle.reset(context), PrivateScanStateError);
});
