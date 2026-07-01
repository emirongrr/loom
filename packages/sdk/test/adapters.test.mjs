import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSdkRequestError,
  createBundlerTransport,
  createPasskeySigner,
  createRpcStateTransport,
  prepareUserOperationEnvelope
} from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const entryPoint = "0x3333333333333333333333333333333333333333";
const intent = Object.freeze({
  kind: "account.calls",
  chainId: 1,
  account,
  calls: Object.freeze([
    Object.freeze({
      target,
      value: 0n,
      data: "0x1234"
    })
  ]),
  authority: Object.freeze({
    risk: "account-execution",
    requiresUserSignature: true,
    requiresGuardianApproval: false,
    delayRequired: false
  })
});

test("bundler transport construction has no network side effects", () => {
  let calls = 0;
  createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    }
  });

  assert.equal(calls, 0);
});

test("bundler transport sends eth_sendUserOperation through explicit endpoint", async () => {
  const requests = [];
  const transport = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "ab".repeat(32) }));
    }
  });
  const envelope = prepareUserOperationEnvelope({
    chainId: 1,
    account,
    intent,
    signature: "0xdeadbeef"
  });
  const result = await transport.sendUserOperation(envelope);

  assert.equal(result.userOpHash, "0x" + "ab".repeat(32));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://bundler.example");
  assert.equal(requests[0].body.method, "eth_sendUserOperation");
  assert.equal(requests[0].body.params[1], entryPoint);
  assert.equal(requests[0].body.params[0].sender, account);
});

test("bundler transport estimates gas with eth_estimateUserOperationGas", async () => {
  const requests = [];
  const transport = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            callGasLimit: "0x10",
            verificationGasLimit: "0x20",
            preVerificationGas: "0x30"
          }
        })
      );
    }
  });
  const envelope = prepareUserOperationEnvelope({
    chainId: 1,
    account,
    intent
  });
  const estimate = await transport.estimateUserOperationGas(envelope);

  assert.equal(requests[0].method, "eth_estimateUserOperationGas");
  assert.deepEqual(estimate, {
    callGasLimit: 16n,
    verificationGasLimit: 32n,
    preVerificationGas: 48n
  });
});

test("bundler transport reads and waits for user operation receipts", async () => {
  let polls = 0;
  const hash = "0x" + "ab".repeat(32);
  const transport = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    pollIntervalMs: 1,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "eth_getUserOperationReceipt") {
        polls += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              polls < 2
                ? null
                : {
                    userOpHash: hash,
                    success: true,
                    receipt: {
                      transactionHash: "0x" + "cd".repeat(32)
                    }
                  }
          })
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hash }));
    }
  });

  const missing = await transport.getUserOperationReceipt({ userOpHash: hash });
  const receipt = await transport.waitForUserOperationReceipt({ userOpHash: hash, timeoutMs: 100 });

  assert.equal(missing, null);
  assert.equal(receipt.userOpHash, hash);
  assert.equal(receipt.success, true);
  assert.equal(polls, 2);
});

test("bundler transport wait times out without inventing inclusion", async () => {
  const transport = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    pollIntervalMs: 1,
    fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }))
  });

  await assert.rejects(
    transport.waitForUserOperationReceipt({
      userOpHash: "0x" + "ab".repeat(32),
      timeoutMs: 5
    }),
    InvalidSdkRequestError
  );
});

test("bundler transport rejects rpc errors and malformed hashes", async () => {
  const failing = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rejected" } }))
  });
  const malformed = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" }))
  });
  const envelope = prepareUserOperationEnvelope({
    chainId: 1,
    account,
    intent,
    signature: "0xdeadbeef"
  });

  await assert.rejects(failing.sendUserOperation(envelope), InvalidSdkRequestError);
  await assert.rejects(malformed.sendUserOperation(envelope), InvalidSdkRequestError);
});

test("state transport construction has no network side effects", () => {
  let calls = 0;
  createRpcStateTransport({
    endpoint: "https://rpc.example",
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    }
  });

  assert.equal(calls, 0);
});

test("state transport sends eth_call through explicit endpoint", async () => {
  const requests = [];
  const transport = createRpcStateTransport({
    endpoint: "https://rpc.example",
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "00".repeat(32) }));
    }
  });
  const result = await transport.ethCall({
    to: account,
    data: "0x12345678",
    blockTag: "safe"
  });

  assert.equal(result, "0x" + "00".repeat(32));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://rpc.example");
  assert.equal(requests[0].body.method, "eth_call");
  assert.deepEqual(requests[0].body.params, [{ to: account, data: "0x12345678" }, "safe"]);
});

test("state transport rejects rpc errors and malformed hex", async () => {
  const failing = createRpcStateTransport({
    endpoint: "https://rpc.example",
    fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rejected" } }))
  });
  const malformed = createRpcStateTransport({
    endpoint: "https://rpc.example",
    fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "not-hex" }))
  });

  await assert.rejects(failing.ethCall({ to: account, data: "0x12345678" }), InvalidSdkRequestError);
  await assert.rejects(malformed.ethCall({ to: account, data: "0x12345678" }), InvalidSdkRequestError);
});

test("passkey signer construction has no credential side effects", () => {
  let calls = 0;
  createPasskeySigner({
    credentialId: "credential-1",
    rpId: "loom.example",
    signChallenge: async () => {
      calls += 1;
      return {
        authenticatorData: "0x01",
        clientDataJSON: "0x02",
        signature: "0x03"
      };
    }
  });

  assert.equal(calls, 0);
});

test("passkey signer binds account chain and intent hash into the challenge", async () => {
  const challenges = [];
  const signer = createPasskeySigner({
    credentialId: "credential-1",
    rpId: "loom.example",
    origin: "https://wallet.example",
    signChallenge: async challenge => {
      challenges.push(challenge);
      return {
        authenticatorData: "0x01",
        clientDataJSON: "0x02",
        signature: "0x03",
        userHandle: "0x04"
      };
    }
  });
  const envelope = prepareUserOperationEnvelope({
    chainId: 1,
    account,
    intent
  });
  const signature = await signer.signUserOperation(envelope);

  assert.match(signature, /^0x[0-9a-f]{64}$/);
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0].account, account);
  assert.equal(challenges[0].chainId, 1);
  assert.equal(challenges[0].intentHash, envelope.intentHash);
  assert.equal(challenges[0].rpId, "loom.example");
});

test("passkey signer rejects malformed authenticator responses", async () => {
  const signer = createPasskeySigner({
    credentialId: "credential-1",
    rpId: "loom.example",
    signChallenge: async () => ({
      authenticatorData: "0x01",
      clientDataJSON: "not-hex",
      signature: "0x03"
    })
  });
  const envelope = prepareUserOperationEnvelope({
    chainId: 1,
    account,
    intent
  });

  await assert.rejects(signer.signUserOperation(envelope), InvalidSdkRequestError);
});

// Walkaway / WalletBeat "custom endpoints, no default provider": the transports
// must never assume a Loom-operated endpoint. Construction fails without an
// explicit, well-formed endpoint rather than silently reaching for a default.

test("bundler transport requires an explicit endpoint and never assumes a default", () => {
  assert.throws(
    () => createBundlerTransport({ entryPoint }),
    error => error instanceof InvalidSdkRequestError
  );
  // A malformed endpoint is rejected rather than silently rewritten to a default.
  assert.throws(() => createBundlerTransport({ endpoint: "not-a-url", entryPoint }));
});

test("state rpc transport requires an explicit endpoint and never assumes a default", () => {
  assert.throws(
    () => createRpcStateTransport({}),
    error => error instanceof InvalidSdkRequestError
  );
});
