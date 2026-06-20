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

test("sdk exposes typed lifecycle encoders and viem-compatible call shapes", () => {
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
  const revokeCallData = sdk.encoders.account.revokeTokenAllowance({
    token,
    spender: target
  });
  const calls = client.toViemCalls(client.prepareCalls({
    calls: [{ target, value: 0n, data: revokeCallData }]
  }));

  assert.equal(revokeCallData.slice(0, 10), "0xbc881467");
  assert.deepEqual(calls, [
    {
      to: target,
      value: 0n,
      data: revokeCallData
    }
  ]);
});

test("client reports truthful ERC-5792 atomic capabilities for the enabled account and chain", () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    }
  });

  assert.deepEqual(client.getCapabilities({ address: account, chainIds: ["0x1", "0x2105"] }), {
    "0x1": {
      atomic: {
        status: "supported"
      }
    }
  });
  assert.deepEqual(client.getCapabilities({
    address: "0x9999999999999999999999999999999999999999",
    chainIds: ["0x1"]
  }), {});
});

test("wallet_sendCalls preparation preserves atomic clear-signing review", () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    }
  });

  const prepared = client.prepareWalletSendCalls({
    version: "2.0.0",
    id: "app-request-1",
    from: account,
    chainId: "0x1",
    atomicRequired: true,
    calls: [
      { to: target, value: "0x2a", data: "0x1234" },
      { to: token, data: "0xabcd" }
    ],
    capabilities: {
      paymasterService: { optional: true, url: "https://paymaster.example" }
    }
  });

  assert.equal(prepared.kind, "wallet_sendCalls.prepare");
  assert.equal(prepared.id, "app-request-1");
  assert.equal(prepared.capabilities.atomic.status, "supported");
  assert.equal(prepared.intent.calls.length, 2);
  assert.equal(prepared.intent.calls[0].value, 42n);
  assert.equal(prepared.review.title, "Execute Loom account calls");
  assert.equal(prepared.review.summary, `Account will execute 2 call(s) from ${account}.`);
});

test("wallet_sendCalls rejects unsupported required capabilities and mismatched chain or account", () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async () => new Response("{}")
    }
  });

  assert.throws(
    () => client.prepareWalletSendCalls({
      chainId: "0x1",
      atomicRequired: true,
      calls: [{ to: target, data: "0x1234" }],
      capabilities: {
        paymasterService: { url: "https://paymaster.example" }
      }
    }),
    error => error instanceof InvalidSdkRequestError && error.details.code === 5700
  );
  assert.throws(
    () => client.prepareWalletSendCalls({
      from: "0x9999999999999999999999999999999999999999",
      chainId: "0x1",
      calls: [{ to: target, data: "0x1234" }]
    }),
    error => error instanceof InvalidSdkRequestError && error.details.code === 4100
  );
  assert.throws(
    () => client.prepareWalletSendCalls({
      chainId: "0x01",
      calls: [{ to: target, data: "0x1234" }]
    }),
    error => error instanceof InvalidSdkRequestError && error.details.code === -32602
  );
});

test("sendWalletCalls returns the app id and rejects duplicate ids", async () => {
  const sent = [];
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
      async sendUserOperation(envelope) {
        sent.push(envelope);
        return { userOpHash: "0x" + "78".repeat(32) };
      }
    }
  });

  const result = await client.sendWalletCalls({
    id: "app-request-2",
    chainId: "0x1",
    atomicRequired: true,
    calls: [{ to: target, data: "0x1234" }]
  });

  assert.equal(result.id, "app-request-2");
  assert.equal(result.capabilities.atomic.status, "supported");
  assert.equal(sent.length, 1);
  await assert.rejects(
    () => client.sendWalletCalls({
      id: "app-request-2",
      chainId: "0x1",
      atomicRequired: true,
      calls: [{ to: target, data: "0x1234" }]
    }),
    /wallet_sendCalls id has already been used/
  );
});
