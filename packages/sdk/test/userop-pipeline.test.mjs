import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeUserOperationHash,
  createLoomClient,
  createRpcStateTransport,
  fetchEntryPointNonce,
  InvalidSdkRequestError,
  prepareUserOperationEnvelope
} from "../dist/index.js";
import { createKohakuHost } from "../../privacy/src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const GET_NONCE_SELECTOR = "0x35567e1a";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../test/fixtures/userop-hash.json", import.meta.url)), "utf8")
);

const providerProfile = {
  mode: "user-rpc",
  chainId: 1,
  endpoint: "https://rpc.example",
  verified: false,
  metadataBudget: {
    protocol: "railgun",
    chainId: 1,
    items: [{ surface: "rpc", reveals: "chain and timing", required: true, mitigation: "user endpoint" }]
  }
};

function minimalEnvelope() {
  const op = fixture.cases.minimal.op;
  return prepareUserOperationEnvelope({
    chainId: Number(fixture.cases.minimal.chainId),
    account: op.sender,
    intent: {
      kind: "account.calls",
      chainId: 1,
      account: op.sender,
      calls: [],
      authority: {
        risk: "account-execution",
        requiresUserSignature: true,
        requiresGuardianApproval: false,
        delayRequired: false
      }
    },
    callData: op.callData,
    nonce: BigInt(op.nonce),
    callGasLimit: 100000n,
    verificationGasLimit: 200000n,
    preVerificationGas: BigInt(op.preVerificationGas),
    maxFeePerGas: 2000000000n,
    maxPriorityFeePerGas: 1000000000n,
    signature: op.signature
  });
}

test("computeUserOperationHash reproduces the differentially-verified fixture hash", () => {
  const envelope = minimalEnvelope();
  assert.equal(
    computeUserOperationHash(envelope, { entryPoint: fixture.cases.minimal.entryPoint }),
    fixture.cases.minimal.userOpHash
  );
});

test("the hash is bound to the EntryPoint and requires one explicitly", () => {
  const envelope = minimalEnvelope();
  const canonical = computeUserOperationHash(envelope, { entryPoint });
  assert.notEqual(canonical, computeUserOperationHash(envelope, { entryPoint: account }));
  assert.throws(() => computeUserOperationHash(envelope, {}), InvalidSdkRequestError);
});

test("fetchEntryPointNonce encodes getNonce(address,uint192) and decodes the result", async () => {
  const calls = [];
  const stateTransport = {
    async ethCall(input) {
      calls.push(input);
      return `0x${"00".repeat(31)}2a`;
    }
  };
  const nonce = await fetchEntryPointNonce({ stateTransport, entryPoint, account, key: 7n });
  assert.equal(nonce, 42n);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, entryPoint);
  assert.equal(
    calls[0].data,
    `${GET_NONCE_SELECTOR}${account.slice(2).padStart(64, "0")}${(7).toString(16).padStart(64, "0")}`
  );
});

test("nonce reads fail closed without a state transport and reject oversized keys", async () => {
  await assert.rejects(fetchEntryPointNonce({ entryPoint, account }), InvalidSdkRequestError);
  await assert.rejects(
    fetchEntryPointNonce({
      stateTransport: { ethCall: async () => "0x00" },
      entryPoint,
      account,
      key: 1n << 192n
    }),
    InvalidSdkRequestError
  );
  await assert.rejects(
    fetchEntryPointNonce({
      stateTransport: { ethCall: async () => "0x" },
      entryPoint,
      account
    }),
    InvalidSdkRequestError
  );
});

test("the client resolves the EntryPoint from its transport and stays explicit otherwise", async () => {
  const rpcCalls = [];
  const stateTransport = createRpcStateTransport({
    endpoint: "https://rpc.example",
    fetch: async (url, init) => {
      rpcCalls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"00".repeat(31)}05` }));
    }
  });
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    transport: { entryPoint, async sendUserOperation() { throw new Error("unused"); } },
    stateTransport
  });

  assert.equal(await client.getEntryPointNonce(), 5n);
  assert.equal(rpcCalls[0].method, "eth_call");
  assert.equal(rpcCalls[0].params[0].to, entryPoint);

  const bare = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
  });
  await assert.rejects(bare.getEntryPointNonce(), InvalidSdkRequestError);
});
