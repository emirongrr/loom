import test from "node:test";
import assert from "node:assert/strict";
import { buildBundlerQualificationEvidence } from "./run-bundler-qualification.mjs";

const ENTRYPOINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TX = "0x" + "11".repeat(32);

test("runner builds validated evidence from two live-smoked independent bundlers", async () => {
  const evidence = await buildBundlerQualificationEvidence({
    config: validConfig(),
    fetch: fakeFetch({
      "https://bundler-a.example/rpc": {
        eth_supportedEntryPoints: [ENTRYPOINT],
        eth_chainId: "0xaa36a7"
      },
      "https://bundler-b.example/rpc": {
        eth_supportedEntryPoints: [ENTRYPOINT],
        eth_chainId: "0xaa36a7"
      }
    })
  });

  assert.equal(evidence.network.chainId, 11155111);
  assert.deepEqual(evidence.bundlers.map(item => item.rpcOrigin), [
    "https://bundler-a.example",
    "https://bundler-b.example"
  ]);
  assert.equal(JSON.stringify(evidence).includes("/rpc"), false);
  assert.equal(JSON.stringify(evidence).includes("url"), false);
  assert.equal(evidence.lifecycle[0].entryPoint, ENTRYPOINT);
  assert.equal(evidence.lifecycle[1].chainId, 11155111);
});

test("runner rejects config with fewer than two bundlers", async () => {
  const config = validConfig();
  config.bundlers.pop();
  await assert.rejects(
    () => buildBundlerQualificationEvidence({ config, fetch: fakeFetch({}) }),
    /at least two bundlers/
  );
});

test("runner rejects secret-bearing bundler URLs before evidence is written", async () => {
  const config = validConfig();
  config.bundlers[1].url = "https://bundler-b.example/rpc?apikey=secret";
  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config,
      fetch: fakeFetch({
        "https://bundler-a.example/rpc": {
          eth_supportedEntryPoints: [ENTRYPOINT],
          eth_chainId: "0xaa36a7"
        }
      })
    }),
    /query/
  );
});

test("runner rejects wrong live chain or unsupported EntryPoint", async () => {
  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch({
        "https://bundler-a.example/rpc": {
          eth_supportedEntryPoints: [ENTRYPOINT],
          eth_chainId: "0x1"
        },
        "https://bundler-b.example/rpc": {
          eth_supportedEntryPoints: [ENTRYPOINT],
          eth_chainId: "0xaa36a7"
        }
      })
    }),
    /unexpected bundler chainId/
  );

  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch({
        "https://bundler-a.example/rpc": {
          eth_supportedEntryPoints: ["0x" + "22".repeat(20)],
          eth_chainId: "0xaa36a7"
        },
        "https://bundler-b.example/rpc": {
          eth_supportedEntryPoints: [ENTRYPOINT],
          eth_chainId: "0xaa36a7"
        }
      })
    }),
    /expected EntryPoint not supported/
  );
});

function validConfig() {
  return {
    version: 1,
    network: { name: "sepolia", chainId: 11155111 },
    entryPoint: ENTRYPOINT,
    bundlers: [
      {
        name: "local-rundler",
        implementation: "rundler",
        operator: "self-hosted",
        endpointKind: "self-hosted",
        url: "https://bundler-a.example/rpc",
        specTests: { passed: true, reference: "eth-infinitism/bundler-spec-tests@sha" }
      },
      {
        name: "third-party-skandha",
        implementation: "skandha",
        operator: "independent-operator",
        endpointKind: "api",
        url: "https://bundler-b.example/rpc",
        specTests: { passed: true, reference: "eth-infinitism/bundler-spec-tests@sha" }
      }
    ],
    lifecycle: [
      lifecycleFor("local-rundler"),
      lifecycleFor("third-party-skandha")
    ],
    checks: {
      counterfactualDeploy: true,
      singleUserOperation: true,
      atomicBatchUserOperation: true,
      nativeGas: true,
      paymasterApproved: true,
      paymasterRejected: true,
      invalidSignatureRejected: true,
      staleNonceRejected: true,
      malformedCalldataRejected: true,
      unsupportedModeRejected: true,
      receiptReconciliation: true,
      permissionlessHandleOpsFallback: true
    },
    receipts: {
      deploy: TX,
      single: TX,
      batch: TX,
      nativeGas: TX,
      paymasterApproved: TX,
      directHandleOpsFallback: TX
    }
  };
}

function lifecycleFor(bundler) {
  return {
    bundler,
    account: "0x" + "33".repeat(20),
    checks: {
      counterfactualDeploy: true,
      singleUserOperation: true,
      atomicBatchUserOperation: true,
      nativeGas: true,
      paymasterApproved: true,
      paymasterRejected: true,
      invalidSignatureRejected: true,
      staleNonceRejected: true,
      malformedCalldataRejected: true,
      unsupportedModeRejected: true,
      receiptReconciliation: true
    },
    stages: {
      session: stage(),
      recovery: stage(),
      migration: stage(),
      vault: stage()
    },
    receipts: {
      deploy: TX,
      single: TX,
      batch: TX,
      nativeGas: TX,
      paymasterApproved: TX,
      paymasterRejected: TX,
      sessionGrant: TX,
      sessionRevoke: TX,
      recoveryProposal: TX,
      recoveryCancel: TX,
      migrationSchedule: TX,
      migrationCancel: TX,
      vaultSchedule: TX,
      vaultCancel: TX
    }
  };
}

function stage() {
  return {
    scheduled: true,
    cancelled: true,
    configBound: true,
    receiptReconciled: true
  };
}

function fakeFetch(responses) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const result = responses[url]?.[body.method];
    if (result === undefined) {
      return new Response(JSON.stringify({ error: { code: -32601, message: "missing method" } }));
    }
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}
