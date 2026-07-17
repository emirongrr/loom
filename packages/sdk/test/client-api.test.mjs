import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSdkRequestError,
  createLoomClient,
  createLoomSdk
} from "../dist/index.js";
import { createKohakuHost } from "../../privacy/src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const factory = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const sessionKey = "0x4444444444444444444444444444444444444444";
const token = "0x5555555555555555555555555555555555555555";
const recoveryModule = "0x6666666666666666666666666666666666666666";
const salt = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const configHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const zeroBytes32 = "0x" + "00".repeat(32);

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

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function bytes32(value) {
  return value.slice(2).padStart(64, "0");
}

function addressWord(value) {
  return value.slice(2).padStart(64, "0");
}

function abi(...words) {
  return `0x${words.join("")}`;
}

function accountStateTransport({
  recoveryConfigured = false,
  guardianRoot = zeroBytes32,
  guardianThreshold = 0n,
  configVersion = 1n,
  frozenUntil = 0n,
  validatorCount = 1n,
  pendingMigration = [
    addressWord("0x0000000000000000000000000000000000000000"),
    bytes32(zeroBytes32),
    bytes32(zeroBytes32),
    bytes32(zeroBytes32),
    word(0n),
    word(0n),
    word(0n),
    word(0n)
  ],
  pendingRecovery
} = {}) {
  const responses = [
    abi(word(recoveryConfigured ? 1n : 0n)),
    abi(bytes32(guardianRoot)),
    abi(word(guardianThreshold)),
    abi(word(configVersion)),
    abi(word(frozenUntil)),
    abi(word(validatorCount)),
    abi(...pendingMigration)
  ];
  if (pendingRecovery !== undefined) responses.push(abi(...pendingRecovery));
  return {
    calls: [],
    async ethCall(input) {
      this.calls.push(input);
      const result = responses.shift();
      if (result === undefined) throw new Error("unexpected eth_call");
      return result;
    }
  };
}

test("loom client construction has no transport signing or provider side effects", () => {
  let calls = 0;
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      host: createKohakuHost({
        providerProfile,
        fetch: async () => {
          calls += 1;
          return new Response("{}");
        }
      })
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
  });

  const deploy = client.prepareDeployAccount({
    factory,
    salt,
    initCode: "0x1234",
    recoveryStatus: "unprotected"
  });
  const prepared = client.prepareUserOperation(deploy);

  assert.equal(deploy.intent.kind, "account.deploy");
  assert.equal(deploy.recoveryStatus, "unprotected");
  assert.equal(deploy.review.risk, "unprotected-recovery");
  assert.match(deploy.review.summary, /without guardian recovery/);
  assert.equal(prepared.kind, "userOperation.prepare");
  assert.equal(prepared.intentHash, deploy.intentHash);
  assert.equal(prepared.userOperation.sender, account);
  assert.equal(prepared.userOperation.callData, "0x1234");
});

test("sendCalls requires explicit signer and transport", async () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
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

test("client reads guardianless recovery onboarding safety state", async () => {
  const stateTransport = accountStateTransport();
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    stateTransport
  });
  const state = await client.readSafetyState({ now: 100n });

  assert.equal(state.kind, "account.safetyState");
  assert.equal(state.status, "unprotected-recovery");
  assert.equal(state.recoveryConfigured, false);
  assert.equal(state.config.guardianRoot, zeroBytes32);
  assert.equal(state.config.guardianThreshold, 0);
  assert.equal(state.config.validatorCount, 1n);
  assert.equal(state.pending.migration.active, false);
  assert.match(state.review.summary, /Guardian recovery is not configured/);
  assert.equal(stateTransport.calls.length, 7);
});

test("client reports pending recovery before ordinary protected state", async () => {
  const root = "0x" + "12".repeat(32);
  const newRoot = "0x" + "34".repeat(32);
  const newValidator = "0x7777777777777777777777777777777777777777";
  const stateTransport = accountStateTransport({
    recoveryConfigured: true,
    guardianRoot: root,
    guardianThreshold: 2n,
    configVersion: 5n,
    pendingRecovery: [
      bytes32("0x" + "56".repeat(32)),
      addressWord(newValidator),
      bytes32("0x" + "78".repeat(32)),
      bytes32(newRoot),
      word(2n),
      word(1000n),
      word(2000n),
      word(6n),
      word(9n)
    ]
  });
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    stateTransport
  });
  const state = await client.readSafetyState({ recoveryModule, now: 500n });

  assert.equal(state.status, "pending-recovery");
  assert.equal(state.recoveryConfigured, true);
  assert.equal(state.config.guardianRoot, root);
  assert.equal(state.config.guardianThreshold, 2);
  assert.equal(state.pending.recovery.active, true);
  assert.equal(state.pending.recovery.newValidator, newValidator);
  assert.equal(state.pending.recovery.newGuardianRoot, newRoot);
  assert.equal(state.pending.recovery.readyAt, 1000n);
  assert.equal(state.coverage.recovery, true);
  assert.equal(state.coverage.recoveryModule, recoveryModule);
  assert.match(state.warnings.join("\n"), /Recovery is pending/);
  assert.equal(stateTransport.calls.length, 8);
});

test("client safety reader marks recovery state coverage partial without recovery module", async () => {
  const root = "0x" + "12".repeat(32);
  const stateTransport = accountStateTransport({
    recoveryConfigured: true,
    guardianRoot: root,
    guardianThreshold: 2n,
    configVersion: 5n
  });
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    stateTransport
  });
  const state = await client.readSafetyState({ now: 500n });

  assert.equal(state.status, "guardian-protected");
  assert.equal(state.coverage.account, true);
  assert.equal(state.coverage.migration, true);
  assert.equal(state.coverage.recovery, false);
  assert.equal("recoveryModule" in state.coverage, false);
  assert.equal(state.pending.recovery, undefined);
  assert.match(state.warnings.join("\n"), /pending recovery state was not read/);
  assert.equal(state.review.summary, "Recovery module was not provided; pending recovery state was not read.");
  assert.equal(stateTransport.calls.length, 7);
});

test("client reports frozen and pending migration safety states", async () => {
  const root = "0x" + "12".repeat(32);
  const destination = "0x8888888888888888888888888888888888888888";
  const stateTransport = accountStateTransport({
    recoveryConfigured: true,
    guardianRoot: root,
    guardianThreshold: 1n,
    frozenUntil: 900n,
    pendingMigration: [
      addressWord(destination),
      bytes32("0x" + "90".repeat(32)),
      bytes32("0x" + "91".repeat(32)),
      bytes32("0x" + "92".repeat(32)),
      word(700n),
      word(1200n),
      word(3n),
      word(4n)
    ]
  });
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    stateTransport
  });
  const state = await client.readSafetyState({ now: 500n });

  assert.equal(state.status, "frozen");
  assert.equal(state.freeze.active, true);
  assert.equal(state.pending.migration.active, true);
  assert.equal(state.pending.migration.destination, destination);
  assert.match(state.warnings.join("\n"), /Account is frozen/);
  assert.match(state.warnings.join("\n"), /Migration is pending/);
});

test("client refuses to read safety state without explicit state transport", async () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
  });

  await assert.rejects(() => client.readSafetyState(), InvalidSdkRequestError);
});

test("client safety reader fails closed on inconsistent guardian state", async () => {
  const client = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    stateTransport: accountStateTransport({
      recoveryConfigured: false,
      guardianRoot: "0x" + "12".repeat(32),
      guardianThreshold: 0n
    })
  });

  await assert.rejects(() => client.readSafetyState(), InvalidSdkRequestError);
});

test("client safety reader fails closed on impossible validator and pending recovery state", async () => {
  const zeroValidatorClient = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    stateTransport: accountStateTransport({
      validatorCount: 0n
    })
  });
  const malformedRecoveryClient = createLoomClient({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
    stateTransport: accountStateTransport({
      recoveryConfigured: true,
      guardianRoot: "0x" + "12".repeat(32),
      guardianThreshold: 1n,
      pendingRecovery: [
        bytes32("0x" + "56".repeat(32)),
        addressWord("0x0000000000000000000000000000000000000000"),
        bytes32("0x" + "78".repeat(32)),
        bytes32("0x" + "34".repeat(32)),
        word(1n),
        word(1000n),
        word(2000n),
        word(6n),
        word(9n)
      ]
    })
  });

  await assert.rejects(() => zeroValidatorClient.readSafetyState(), InvalidSdkRequestError);
  await assert.rejects(
    () => malformedRecoveryClient.readSafetyState({ recoveryModule }),
    InvalidSdkRequestError
  );
});

test("high-level client delegates session and recovery lifecycle builders", () => {
  const sdk = createLoomSdk({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
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
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) },
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

// Privacy is an optional layer: a client with no Kohaku host must construct
// and run the whole non-private path, and only touching the privacy runtime
// itself may fail — at use, with the typed error.
test("loom client works end to end without a kohaku host", async () => {
  const submitted = [];
  const client = createLoomClient({
    chainId: 1,
    account,
    signer: {
      async signUserOperation() {
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

  const prepared = client.prepareCalls({ calls: [{ target, value: 0n, data: "0x1234" }] });
  assert.equal(prepared.kind, "account.calls.prepare");

  const sent = await client.sendCalls({ calls: [{ target, value: 0n, data: "0x1234" }] });
  assert.equal(sent.userOpHash, "0x" + "12".repeat(32));
  assert.equal(submitted[0].userOperation.signature, "0xdeadbeef");
});

test("touching the kohaku runtime without a host fails at use with the typed error", () => {
  const sdk = createLoomSdk({ chainId: 1, account });
  assert.throws(
    () => sdk.kohaku,
    error => error instanceof InvalidSdkRequestError && /kohaku host is required/.test(error.message)
  );
});
