import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/domain/errors/appError.ts";
import {
  DEFAULT_NETWORK,
  invalidNetworkEndpoints,
  loadNetworkConfig,
  normalizeNetworkConfig,
  saveNetworkConfig
} from "../src/config/network.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); }
  } as Storage;
}

test("a rejected endpoint is not silently replaced with the public default", () => {
  const storage = memoryStorage();
  const chosen = { ...DEFAULT_NETWORK, rpcUrl: "https://rpc.example/mine" };
  saveNetworkConfig(chosen, storage);

  const typo = { ...chosen, rpcUrl: "htps://rpc.example/mine" };
  assert.throws(() => saveNetworkConfig(typo, storage), (issue: unknown) => {
    assert.ok(issue instanceof AppError);
    assert.equal(issue.code, "CONFIGURATION_ERROR");
    assert.match(issue.userMessage, /RPC endpoint/);
    assert.equal(issue.metadata.fields, "rpcUrl");
    return true;
  });

  // The previous choice survives: nothing was written, and in particular the
  // user was not moved back onto the public default without being told.
  assert.equal(loadNetworkConfig(storage).rpcUrl, "https://rpc.example/mine");
});

test("every rejected field is named at once", () => {
  const storage = memoryStorage();
  assert.deepEqual(
    invalidNetworkEndpoints({ ...DEFAULT_NETWORK, rpcUrl: "ftp://x", bundlerUrl: "not a url" }),
    ["rpcUrl", "bundlerUrl"]
  );
  assert.throws(
    () => saveNetworkConfig({ ...DEFAULT_NETWORK, rpcUrl: "ftp://x", bundlerUrl: "not a url" }, storage),
    /RPC endpoint, Bundler endpoint/
  );
});

test("plain http is accepted for localhost only, and the relay may be empty", () => {
  const storage = memoryStorage();
  assert.deepEqual(invalidNetworkEndpoints({ relayUrl: "" }), []);
  assert.deepEqual(invalidNetworkEndpoints({ relayUrl: "http://localhost:8787" }), []);
  assert.deepEqual(invalidNetworkEndpoints({ relayUrl: "http://sponsor.example" }), ["relayUrl"]);
  assert.deepEqual(invalidNetworkEndpoints({ rpcUrl: "" }), ["rpcUrl"]);
  assert.equal(saveNetworkConfig({ ...DEFAULT_NETWORK, relayUrl: "http://localhost:8787" }, storage).relayUrl, "http://localhost:8787");
});

test("stored configuration still recovers rather than leaving the wallet unusable", () => {
  // The opposite decision from the save path, on purpose: a damaged record must
  // not leave the wallet unable to reach a chain.
  const storage = memoryStorage();
  storage.setItem("loom.wallet.network.v1", JSON.stringify({ rpcUrl: "nonsense", bundlerUrl: DEFAULT_NETWORK.bundlerUrl }));
  assert.equal(loadNetworkConfig(storage).rpcUrl, DEFAULT_NETWORK.rpcUrl);
  assert.equal(normalizeNetworkConfig({ rpcUrl: "nonsense" }).rpcUrl, DEFAULT_NETWORK.rpcUrl);
});
