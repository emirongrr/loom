import assert from "node:assert/strict";
import test from "node:test";
import {
  createBundlerTransport,
  createLoomClient,
  createPasskeySigner,
  InvalidSdkRequestError
} from "../dist/index.js";
import { createKohakuHost } from "../../privacy/src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const validator = "0x9999999999999999999999999999999999999999";
const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

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

function kohaku() {
  return { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) };
}

function passkey() {
  return createPasskeySigner({
    credentialId: "cred-1",
    rpId: "wallet.example",
    origin: "https://wallet.example",
    validator,
    entryPoint,
    signChallenge: async () => ({
      authenticatorData: `0x${"01".repeat(37)}`,
      clientDataJSON: "0x02",
      signature: `0x${"05".padStart(64, "0")}${"07".padStart(64, "0")}`
    })
  });
}

// A bundler that records what it saw and returns realistic estimate/fees/receipt.
function recordingBundler(events) {
  return Object.freeze({
    entryPoint,
    async getUserOperationGasPrice(tier) {
      events.push({ type: "gasPrice", tier });
      return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    },
    async estimateUserOperationGas(envelope) {
      events.push({ type: "estimate", op: envelope.userOperation });
      return { callGasLimit: 90_000n, verificationGasLimit: 500_000n, preVerificationGas: 45_000n };
    },
    async sendUserOperation(envelope) {
      events.push({ type: "send", op: envelope.userOperation });
      return { userOpHash: `0x${"ab".repeat(32)}` };
    },
    async waitForUserOperationReceipt({ userOpHash }) {
      events.push({ type: "wait", userOpHash });
      // A real transport (createBundlerTransport) decodes quantities; the send
      // path surfaces that receipt unchanged.
      return { userOpHash, sender: account, nonce: 7n, success: true, actualGasCost: 0x2386f26fc10000n };
    }
  });
}

function stateWithNonce(events, value) {
  return {
    async ethCall(input) {
      events.push({ type: "ethCall", to: input.to });
      return `0x${value.toString(16).padStart(64, "0")}`;
    }
  };
}

test("sendTransaction fills nonce, fees, and gas before signing, then sends and reports a typed receipt", async () => {
  const events = [];
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: kohaku(),
    signer: passkey(),
    transport: recordingBundler(events),
    stateTransport: stateWithNonce(events, 7n)
  });

  const result = await client.sendTransaction({ calls: [{ target, value: 0n, data: "0x1234" }] });

  // Nonce came from the EntryPoint, fees and gas from the bundler oracle/estimate.
  const sent = events.find(e => e.type === "send").op;
  assert.equal(sent.nonce, 7n);
  assert.equal(sent.maxFeePerGas, 2_000_000_000n);
  assert.equal(sent.callGasLimit, 90_000n);
  // Estimated 500k plus the passkey signer 400k buffer: a hash-bound WebAuthn
  // challenge means estimation can never exercise the P-256 tail, so the signer
  // declares the unseen verification gas and fill adds it.
  assert.equal(sent.verificationGasLimit, 900_000n);
  // The sent signature is the real envelope (embeds the validator), not the dummy.
  assert.ok(sent.signature.includes(validator.slice(2)));
  assert.ok(sent.signature.includes("05".padStart(64, "0")));

  // Estimation ran with the dummy signature, before the real one existed.
  const estimate = events.find(e => e.type === "estimate").op;
  assert.notEqual(estimate.signature, "0x");
  assert.ok(events.findIndex(e => e.type === "estimate") < events.findIndex(e => e.type === "send"));

  // Typed receipt: quantities decoded to bigint.
  assert.equal(result.receipt.success, true);
  assert.equal(result.receipt.nonce, 7n);
  assert.equal(result.receipt.actualGasCost, 0x2386f26fc10000n);
  assert.equal(result.userOpHash, `0x${"ab".repeat(32)}`);
});

test("explicit fees and gas skip the oracle and estimate", async () => {
  const events = [];
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: kohaku(),
    signer: passkey(),
    transport: recordingBundler(events),
    stateTransport: stateWithNonce(events, 3n)
  });

  await client.sendTransaction(
    { calls: [{ target, value: 0n, data: "0x1234" }] },
    {
      nonce: 12n,
      maxFeePerGas: 5n,
      maxPriorityFeePerGas: 4n,
      callGasLimit: 1n,
      verificationGasLimit: 2n,
      preVerificationGas: 3n
    }
  );

  assert.equal(events.some(e => e.type === "gasPrice"), false);
  assert.equal(events.some(e => e.type === "estimate"), false);
  assert.equal(events.some(e => e.type === "ethCall"), false);
  const sent = events.find(e => e.type === "send").op;
  assert.equal(sent.nonce, 12n);
  assert.equal(sent.maxFeePerGas, 5n);
  assert.equal(sent.callGasLimit, 1n);
});

test("fee fill fails closed when the bundler has no gas oracle and fees are not explicit", async () => {
  const events = [];
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: kohaku(),
    signer: passkey(),
    transport: {
      entryPoint,
      async estimateUserOperationGas() {
        return { callGasLimit: 1n, verificationGasLimit: 2n, preVerificationGas: 3n };
      },
      async sendUserOperation() {
        return { userOpHash: `0x${"ab".repeat(32)}` };
      }
    },
    stateTransport: stateWithNonce(events, 1n)
  });

  await assert.rejects(
    client.sendTransaction({ calls: [{ target, value: 0n, data: "0x1234" }] }),
    InvalidSdkRequestError
  );
});

test("the bundler transport decodes a raw receipt into typed fields", async () => {
  const hash = `0x${"ab".repeat(32)}`;
  const transport = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    fetch: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            userOpHash: hash,
            sender: account,
            nonce: "0x7",
            success: true,
            actualGasCost: "0x2386f26fc10000",
            actualGasUsed: "0x1e8480",
            receipt: { transactionHash: `0x${"cd".repeat(32)}` }
          }
        })
      )
  });
  const receipt = await transport.getUserOperationReceipt({ userOpHash: hash });
  assert.equal(receipt.nonce, 7n);
  assert.equal(receipt.sender, account);
  assert.equal(receipt.actualGasCost, 0x2386f26fc10000n);
  assert.equal(receipt.actualGasUsed, 0x1e8480n);
  assert.equal(receipt.success, true);
});

test("the bundler gas oracle decodes the requested tier", async () => {
  const transport = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint,
    fetch: async (url, init) => {
      assert.equal(JSON.parse(init.body).method, "pimlico_getUserOperationGasPrice");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            standard: { maxFeePerGas: "0x10", maxPriorityFeePerGas: "0x1" },
            fast: { maxFeePerGas: "0x20", maxPriorityFeePerGas: "0x2" }
          }
        })
      );
    }
  });

  assert.deepEqual(await transport.getUserOperationGasPrice(), { maxFeePerGas: 16n, maxPriorityFeePerGas: 1n });
  assert.deepEqual(await transport.getUserOperationGasPrice("fast"), { maxFeePerGas: 32n, maxPriorityFeePerGas: 2n });
  await assert.rejects(transport.getUserOperationGasPrice("missing"), InvalidSdkRequestError);
});
