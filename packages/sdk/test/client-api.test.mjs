import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSdkRequestError,
  createLoomClient,
  createLoomSdk
} from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const factory = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const sessionKey = "0x4444444444444444444444444444444444444444";
const token = "0x5555555555555555555555555555555555555555";
const salt = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const configHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const providerProfile = {
  mode: "user-rpc",
  chainId: 1,
  endpoint: "https://rpc.example",
  verified: false,
  metadataBudget: {
    protocol: "railgun",
    chainId: 1,
    items: [
      {
        surface: "rpc",
        reveals: "target chain and request timing",
        required: true,
        mitigation: "user selected endpoint"
      }
    ]
  }
};

test("loom client construction has no transport signing or provider side effects", () => {
  let calls = 0;
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => {
        calls += 1;
        return new Response("{}");
      }
    }
  });

  assert.equal(client.account, account);
  assert.equal(client.chainId, 1);
  assert.equal(calls, 0);
});

test("loom client prepares deploy and user operation envelopes without broadcasting", async () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    }
  });

  const deploy = client.prepareDeployAccount({
    factory,
    salt,
    initCode: "0x1234"
  });
  const prepared = client.prepareUserOperation(deploy);

  assert.equal(deploy.intent.kind, "account.deploy");
  assert.equal(prepared.kind, "userOperation.prepare");
  assert.equal(prepared.intentHash, deploy.intentHash);
  assert.equal(prepared.userOperation.sender, account);
  assert.equal(prepared.userOperation.callData, "0x1234");
});

test("sendCalls requires explicit signer and transport", async () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    }
  });

  await assert.rejects(
    client.sendCalls({
      calls: [{ target, value: 0n, data: "0x1234" }]
    }),
    InvalidSdkRequestError
  );
});

test("sendCalls builds signs and submits through caller-supplied transport", async () => {
  const submitted = [];
  const signed = [];
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    },
    signer: {
      async signUserOperation(envelope) {
        signed.push(envelope);
        return "0xdeadbeef";
      }
    },
    transport: {
      async sendUserOperation(envelope) {
        submitted.push(envelope);
        return { userOpHash: "0x" + "12".repeat(32) };
      }
    }
  });

  const result = await client.sendCalls({
    calls: [{ target, value: 0n, data: "0x1234" }]
  });

  assert.equal(result.userOpHash, "0x" + "12".repeat(32));
  assert.equal(signed.length, 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].userOperation.signature, "0xdeadbeef");
  assert.equal(submitted[0].userOperation.sender, account);
});

test("sendCalls runs optional middleware before signing", async () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    },
    signer: {
      async signUserOperation(envelope) {
        assert.equal(envelope.userOperation.callGasLimit, 10n);
        return "0xdeadbeef";
      }
    },
    transport: {
      async sendUserOperation(envelope) {
        return { userOpHash: envelope.intentHash };
      }
    },
    middleware: [
      async envelope => ({
        ...envelope,
        userOperation: {
          ...envelope.userOperation,
          callGasLimit: 10n
        }
      })
    ]
  });

  const result = await client.sendCalls({
    calls: [{ target, value: 0n, data: "0x1234" }]
  });

  assert.match(result.userOpHash, /^0x[0-9a-f]{64}$/);
});

test("sendCallsAndWait submits and resolves receipt through transport", async () => {
  const receipt = {
    userOpHash: "0x" + "34".repeat(32),
    success: true,
    receipt: { transactionHash: "0x" + "56".repeat(32) }
  };
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    },
    signer: {
      async signUserOperation() {
        return "0xdeadbeef";
      }
    },
    transport: {
      async sendUserOperation() {
        return { userOpHash: receipt.userOpHash };
      },
      async waitForUserOperationReceipt({ userOpHash }) {
        assert.equal(userOpHash, receipt.userOpHash);
        return receipt;
      }
    }
  });

  const result = await client.sendCallsAndWait({
    calls: [{ target, value: 0n, data: "0x1234" }]
  });

  assert.deepEqual(result.receipt, receipt);
});

test("estimateCalls delegates to caller supplied transport", async () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    },
    transport: {
      async estimateUserOperationGas(envelope) {
        assert.equal(envelope.account, account);
        return {
          callGasLimit: 1n,
          verificationGasLimit: 2n,
          preVerificationGas: 3n
        };
      }
    }
  });

  const estimate = await client.estimateCalls({
    calls: [{ target, value: 0n, data: "0x1234" }]
  });

  assert.equal(estimate.callGasLimit, 1n);
});

test("high-level client delegates session and recovery lifecycle builders", () => {
  const sdk = createLoomSdk({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    }
  });
  const client = createLoomClient({
    chainId: 1,
    account,
    sdk
  });

  const session = client.grantSession({
    origin: "https://app.example",
    sessionKey,
    target,
    selector: "0x12345678",
    token,
    maxAmount: 100n,
    validUntil: 200n,
    maxUses: 3
  });
  const recovery = client.proposeRecovery({
    newConfigHash: configHash,
    configVersion: 2n,
    executeAfter: 1000n
  });

  assert.equal(session.intent.kind, "session.grant");
  assert.equal(session.intent.appScope.applicationId.startsWith("app:"), true);
  assert.equal(recovery.intent.kind, "recovery.propose");
  assert.equal(recovery.review.requiresGuardianApproval, true);
});
