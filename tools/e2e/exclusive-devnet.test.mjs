import assert from "node:assert/strict";
import test from "node:test";
import { devnetPort, occupiedMessage, requireExclusiveDevnet, whoIsServing } from "./exclusive-devnet.mjs";

const answering = chainId => async () => ({
  ok: true,
  json: async () => ({ jsonrpc: "2.0", id: 1, result: chainId })
});
const refused = async () => { throw new Error("ECONNREFUSED"); };

test("a free port reports nobody serving", async () => {
  assert.equal(await whoIsServing("http://127.0.0.1:8545", { fetchImpl: refused }), null);
});

test("an occupied port reports the chain it answers with", async () => {
  assert.equal(await whoIsServing("http://127.0.0.1:8545", { fetchImpl: answering("0x7a69") }), "0x7a69");
});

// Something listening that is not a node is still something listening, but it
// is not a chain -- and the rehearsal's own anvil will fail to bind either way.
// Reporting null here is deliberate: the guard's job is to catch a foreign
// chain, and anvil's own bind failure covers the rest.
test("a listener that is not a JSON-RPC node is not reported as a chain", async () => {
  const html = async () => ({ ok: true, json: async () => { throw new Error("not json"); } });
  assert.equal(await whoIsServing("http://127.0.0.1:8545", { fetchImpl: html }), null);
});

test("an occupied devnet is refused, not shared", async () => {
  await assert.rejects(
    () => requireExclusiveDevnet("http://127.0.0.1:8545", { fetchImpl: answering("0x7a69") }),
    /already serving a chain/
  );
});

test("a free devnet is allowed through", async () => {
  await requireExclusiveDevnet("http://127.0.0.1:8545", { fetchImpl: refused });
});

// The message has to be actionable: the reader's next move is to stop the other
// node or move this one, and both are named.
test("the refusal says what to do about it", () => {
  const message = occupiedMessage("http://127.0.0.1:8545", "0x7a69");
  assert.match(message, /DEVNET_RPC_URL/);
  assert.match(message, /Stop the other node/);
});

test("the anvil port comes from the url the rehearsal will read", () => {
  assert.equal(devnetPort("http://127.0.0.1:8546"), "8546");
});

// A url without a port would silently mean 80, and anvil would bind somewhere
// the rehearsal never looks.
test("a url without a port is refused rather than defaulted", () => {
  assert.throws(() => devnetPort("http://127.0.0.1"), /must name a port/);
});
