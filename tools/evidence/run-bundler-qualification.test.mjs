import test from "node:test";
import assert from "node:assert/strict";
import { buildBundlerQualificationEvidence } from "./run-bundler-qualification.mjs";

const ENTRYPOINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TX = "0x" + "11".repeat(32);
const BLOCK = "0x" + "22".repeat(32);
const NODE_URL = "https://node.example/rpc";

test("runner builds validated evidence from two live-smoked independent bundlers", async () => {
  const config = validConfig();
  config.checks.singleUserOperation = false;
  config.lifecycle[0].checks.atomicBatchUserOperation = false;
  config.lifecycle[0].stages.session.scheduled = false;
  const evidence = await buildBundlerQualificationEvidence({
    config,
    fetch: fakeFetch(liveResponses())
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
  assert.equal(evidence.lifecycle[0].rejections.staleNonceRejected.rpcCode, -32500);
  assert.equal(evidence.lifecycle[0].executions.deploy.receiptReconciled, true);
  assert.equal(evidence.lifecycle[0].executions.deploy.eventReconciled, true);
  assert.equal(evidence.lifecycle[0].executions.deploy.stateChecks, 1);
  assert.match(evidence.lifecycle[0].executions.deploy.userOperationHash, /^0x[0-9a-f]{64}$/);
  assert.equal(evidence.lifecycle[0].receipts.deploy, evidence.lifecycle[0].executions.deploy.transactionHash);
  assert.equal(evidence.checks.singleUserOperation, true);
  assert.equal(evidence.lifecycle[0].checks.atomicBatchUserOperation, true);
  assert.equal(evidence.lifecycle[0].stages.session.scheduled, true);
  assert.equal(JSON.stringify(evidence).includes("local-signed-vector"), false);
  assert.equal(JSON.stringify(evidence).includes("positive-signed-vector"), false);
  assert.equal(JSON.stringify(evidence).includes("node.example"), false);
});

test("runner rejects config with fewer than two bundlers", async () => {
  const config = validConfig();
  config.bundlers.pop();
  await assert.rejects(
    () => buildBundlerQualificationEvidence({ config, fetch: fakeFetch({}) }),
    /at least two bundlers/
  );
});

test("runner rejects legacy qualification configs without live execution evidence", async () => {
  const config = validConfig();
  config.version = 1;
  await assert.rejects(
    () => buildBundlerQualificationEvidence({ config, fetch: fakeFetch(liveResponses()) }),
    /unsupported bundler qualification config version/
  );
});

test("runner rejects secret-bearing bundler URLs before evidence is written", async () => {
  const config = validConfig();
  config.bundlers[1].url = "https://bundler-b.example/rpc?apikey=secret";
  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config,
      fetch: fakeFetch({
        [NODE_URL]: { eth_chainId: "0xaa36a7" },
        "https://bundler-a.example/rpc": {
          eth_supportedEntryPoints: [ENTRYPOINT],
          eth_chainId: "0xaa36a7"
        }
      })
    }),
    /query/
  );
});

test("runner rejects secret-bearing spec-test references before evidence is written", async () => {
  const config = validConfig();
  config.bundlers[0].specTests.reference = "https://ci.example/bundler-spec?access_token=secret";
  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config,
      fetch: fakeFetch({
        [NODE_URL]: { eth_chainId: "0xaa36a7" },
        "https://bundler-a.example/rpc": {
          eth_supportedEntryPoints: [ENTRYPOINT],
          eth_chainId: "0xaa36a7"
        },
        "https://bundler-b.example/rpc": {
          eth_supportedEntryPoints: [ENTRYPOINT],
          eth_chainId: "0xaa36a7"
        }
      })
    }),
    /secret-bearing material/
  );
});

test("runner rejects wrong live chain or unsupported EntryPoint", async () => {
  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch({
        [NODE_URL]: { eth_chainId: "0xaa36a7" },
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
        [NODE_URL]: { eth_chainId: "0xaa36a7" },
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

test("runner rejects an accepted negative vector or an included rejected operation", async () => {
  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch(liveResponses(), { acceptNegative: true })
    }),
    /unexpectedly accepted/
  );

  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch(liveResponses(), { includeNegative: true })
    }),
    /unexpectedly has a receipt/
  );
});

test("runner rejects failed positive execution, node receipt drift, and post-state mismatch", async () => {
  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch(liveResponses(), { failPositive: true })
    }),
    /did not succeed/
  );

  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch(liveResponses(), { nodeReceiptDrift: true })
    }),
    /chain receipt does not match/
  );

  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch(liveResponses(), { stateMismatch: true })
    }),
    /post-state mismatch/
  );

  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch(liveResponses(), { missingEvent: true })
    }),
    /UserOperationEvent was not reconciled/
  );
});

test("runner polls pending receipts and fails closed when inclusion times out", async () => {
  let sleeps = 0;
  await buildBundlerQualificationEvidence({
    config: validConfig(),
    fetch: fakeFetch(liveResponses(), { delayPositiveReceiptOnce: true }),
    sleep: async () => { sleeps += 1; },
    receiptAttempts: 2,
    receiptPollIntervalMs: 0
  });
  assert.equal(sleeps, 26);

  await assert.rejects(
    () => buildBundlerQualificationEvidence({
      config: validConfig(),
      fetch: fakeFetch(liveResponses(), { neverIncludePositive: true }),
      sleep: async () => {},
      receiptAttempts: 1,
      receiptPollIntervalMs: 0
    }),
    /receipt was not available before timeout/
  );
});

function validConfig() {
  return {
    version: 2,
    network: { name: "sepolia", chainId: 11155111 },
    nodeUrl: NODE_URL,
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
    lifecycleVectors: [
      lifecycleVectorsFor("local-rundler"),
      lifecycleVectorsFor("third-party-skandha")
    ],
    rejectionVectors: [
      rejectionVectorsFor("local-rundler"),
      rejectionVectorsFor("third-party-skandha")
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

function rejectionVectorsFor(bundler) {
  const vector = () => ({
    userOperation: { sender: "0x" + "33".repeat(20), signature: "local-signed-vector" },
    userOperationHash: TX
  });
  return {
    bundler,
    vectors: {
      paymasterRejected: vector(),
      invalidSignatureRejected: vector(),
      staleNonceRejected: vector(),
      malformedCalldataRejected: vector(),
      unsupportedModeRejected: vector()
    }
  };
}

function lifecycleVectorsFor(bundler) {
  const vector = () => ({
    userOperation: { sender: "0x" + "33".repeat(20), signature: "positive-signed-vector" },
    postState: [{ to: "0x" + "33".repeat(20), data: "0x12345678", expectedResult: "0x01" }]
  });
  return {
    bundler,
    operations: {
      deploy: vector(),
      single: vector(),
      batch: vector(),
      nativeGas: vector(),
      paymasterApproved: vector(),
      sessionGrant: vector(),
      sessionRevoke: vector(),
      recoveryProposal: vector(),
      recoveryCancel: vector(),
      migrationSchedule: vector(),
      migrationCancel: vector(),
      vaultSchedule: vector(),
      vaultCancel: vector()
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

function fakeFetch(responses, options = {}) {
  let sequence = 0;
  const included = new Map();
  const transactions = new Map();
  const receiptReads = new Map();
  return async (url, init) => {
    const body = JSON.parse(init.body);
    let result = responses[url]?.[body.method];
    if (result === undefined && body.method === "eth_sendUserOperation") {
      const negative = body.params[0].signature === "local-signed-vector";
      if (!negative) {
        sequence += 1;
        const userOperationHash = quantityHash(sequence);
        const transactionHash = quantityHash(sequence + 100);
        const receipt = userOperationReceipt(userOperationHash, transactionHash, options.failPositive && sequence === 1);
        included.set(userOperationHash, receipt);
        transactions.set(transactionHash, receipt.receipt);
        result = userOperationHash;
      } else if (options.acceptNegative) {
        result = TX;
      } else {
        return new Response(JSON.stringify({ error: { code: -32500, message: "rejected test vector" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
    if (result === undefined && body.method === "eth_getUserOperationReceipt") {
      const userOperationHash = body.params[0];
      const positiveReceipt = included.get(userOperationHash);
      const reads = receiptReads.get(userOperationHash) ?? 0;
      receiptReads.set(userOperationHash, reads + 1);
      if (positiveReceipt && (options.neverIncludePositive || (options.delayPositiveReceiptOnce && reads === 0))) {
        result = null;
      } else {
        result = positiveReceipt ?? (options.includeNegative ? { transactionHash: TX } : null);
      }
    }
    if (result === undefined && body.method === "eth_getTransactionReceipt") {
      result = transactions.get(body.params[0]);
      if (options.nodeReceiptDrift && result) result = { ...result, blockHash: TX };
      if (options.missingEvent && result) result = { ...result, logs: [] };
    }
    if (result === undefined && body.method === "eth_call") {
      result = options.stateMismatch ? "0x02" : "0x01";
    }
    if (result === undefined) {
      return new Response(JSON.stringify({ error: { code: -32601, message: "missing method" } }));
    }
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function liveResponses() {
  return {
    "https://bundler-a.example/rpc": {
      eth_supportedEntryPoints: [ENTRYPOINT],
      eth_chainId: "0xaa36a7"
    },
    "https://bundler-b.example/rpc": {
      eth_supportedEntryPoints: [ENTRYPOINT],
      eth_chainId: "0xaa36a7"
    },
    [NODE_URL]: {
      eth_chainId: "0xaa36a7"
    }
  };
}

function quantityHash(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function userOperationReceipt(userOperationHash, transactionHash, failed) {
  return {
    userOpHash: userOperationHash,
    sender: "0x" + "33".repeat(20),
    success: !failed,
    receipt: {
      transactionHash,
      blockHash: BLOCK,
      blockNumber: "0x123",
      status: "0x1",
      logs: [{
        address: ENTRYPOINT,
        topics: [
          "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f",
          userOperationHash
        ]
      }]
    }
  };
}
