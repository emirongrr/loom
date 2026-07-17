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

// Account execution encoding is what makes calls actually run on-chain. The
// wallet engine encodes LoomAccount.execute(bytes32 mode, bytes calldata) with
// the account's narrowed ERC-7579 layout (mode[0] 0x00 single, 0x01 batch;
// executionCalldata = abi.encode(Execution) or abi.encode(Execution[])). These
// vectors are the exact bytes viem's encodeFunctionData produces for the same
// inputs and were proven to execute through a real EntryPoint by
// tools/e2e/bundler-devnet.mjs; a drift here silently breaks every send.
function callData(calls) {
  return prepareUserOperationEnvelope({
    chainId: 1,
    account,
    intent: {
      kind: "account.calls",
      chainId: 1,
      account,
      calls,
      authority: {
        risk: "account-execution",
        requiresUserSignature: true,
        requiresGuardianApproval: false,
        delayRequired: false
      }
    }
  }).userOperation.callData;
}

test("single-call execution matches the account's ERC-7579 execute encoding", () => {
  const encoded = callData([
    { target: "0x2222222222222222222222222222222222222222", value: 5n, data: "0xdeadbeef" }
  ]);
  assert.equal(
    encoded,
    "0xe9ae5c53" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "00000000000000000000000000000000000000000000000000000000000000c0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000002222222222222222222222222222222222222222" +
      "0000000000000000000000000000000000000000000000000000000000000005" +
      "0000000000000000000000000000000000000000000000000000000000000060" +
      "0000000000000000000000000000000000000000000000000000000000000004" +
      "deadbeef00000000000000000000000000000000000000000000000000000000"
  );
});

test("batch execution matches the account's ERC-7579 execute encoding", () => {
  const encoded = callData([
    { target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0x1234" },
    { target: "0x3333333333333333333333333333333333333333", value: 7n, data: "0xabcdef012345" }
  ]);
  assert.equal(
    encoded,
    "0xe9ae5c53" +
      "0100000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "00000000000000000000000000000000000000000000000000000000000001c0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000002" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "00000000000000000000000000000000000000000000000000000000000000e0" +
      "0000000000000000000000002222222222222222222222222222222222222222" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000060" +
      "0000000000000000000000000000000000000000000000000000000000000002" +
      "1234000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000003333333333333333333333333333333333333333" +
      "0000000000000000000000000000000000000000000000000000000000000007" +
      "0000000000000000000000000000000000000000000000000000000000000060" +
      "0000000000000000000000000000000000000000000000000000000000000006" +
      "abcdef012345000000000000000000000000000000000000000000000000000000".slice(0, 64)
  );
});

test("call values outside uint256 are rejected at the boundary with a clear error", () => {
  const target = "0x2222222222222222222222222222222222222222";
  assert.throws(
    () => callData([{ target, value: -5n, data: "0x" }]),
    error => error instanceof InvalidSdkRequestError && /value must fit uint256/.test(error.message)
  );
  assert.throws(
    () => callData([{ target, value: 1n << 256n, data: "0x" }]),
    error => error instanceof InvalidSdkRequestError && /value must fit uint256/.test(error.message)
  );
  // The boundary is inclusive of the maximum representable value.
  assert.ok(callData([{ target, value: (1n << 256n) - 1n, data: "0x" }]).startsWith("0xe9ae5c53"));
});
