import test from "node:test";
import assert from "node:assert/strict";
import { assertBundlerUrl, smokeBundler } from "./bundler-smoke.mjs";

const ENTRYPOINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";

test("bundler smoke accepts supported entrypoint and expected chain", async () => {
  const result = await smokeBundler({
    bundlerUrl: "https://bundler.example/rpc",
    expectedEntryPoint: ENTRYPOINT,
    expectedChainId: 11155111,
    fetch: fakeFetch({
      eth_supportedEntryPoints: [ENTRYPOINT],
      eth_chainId: "0xaa36a7"
    })
  });

  assert.deepEqual(result, {
    rpcOrigin: "https://bundler.example",
    chainId: 11155111,
    entryPoint: ENTRYPOINT,
    supportedEntryPoints: [ENTRYPOINT]
  });
});

test("bundler smoke rejects wrong entrypoint and wrong chain", async () => {
  await assert.rejects(
    () => smokeBundler({
      bundlerUrl: "https://bundler.example/rpc",
      expectedEntryPoint: ENTRYPOINT,
      expectedChainId: 11155111,
      fetch: fakeFetch({
        eth_supportedEntryPoints: ["0x" + "22".repeat(20)],
        eth_chainId: "0xaa36a7"
      })
    }),
    /expected EntryPoint not supported/
  );

  await assert.rejects(
    () => smokeBundler({
      bundlerUrl: "https://bundler.example/rpc",
      expectedEntryPoint: ENTRYPOINT,
      expectedChainId: 11155111,
      fetch: fakeFetch({
        eth_supportedEntryPoints: [ENTRYPOINT],
        eth_chainId: "0x1"
      })
    }),
    /unexpected bundler chainId/
  );
});

test("bundler smoke rejects secret-bearing endpoint metadata", () => {
  assert.throws(() => assertBundlerUrl("https://user:pass@bundler.example/rpc"), /credentials/);
  assert.throws(() => assertBundlerUrl("https://bundler.example/rpc?apikey=secret"), /query/);
  assert.throws(() => assertBundlerUrl("wss://bundler.example/rpc"), /http or https/);
});

function fakeFetch(responses) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!(body.method in responses)) {
      return new Response(JSON.stringify({ error: { code: -32601, message: "missing method" } }));
    }
    return new Response(JSON.stringify({ result: responses[body.method] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}
