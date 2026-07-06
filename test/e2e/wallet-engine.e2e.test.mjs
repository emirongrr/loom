import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSdkRequestError,
  createLoomClient,
  createPasskeySigner,
  hashCanonical
} from "../../packages/sdk/src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const factory = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const forbiddenTarget = "0x3333333333333333333333333333333333333334";
const sessionKey = "0x4444444444444444444444444444444444444444";
const token = "0x5555555555555555555555555555555555555555";
const recipient = "0x6666666666666666666666666666666666666666";
const recoveryModule = "0x7777777777777777777777777777777777777777";
const destination = "0x8888888888888888888888888888888888888888";
const salt = `0x${"aa".repeat(32)}`;
const configHash = `0x${"bb".repeat(32)}`;
const codeHash = `0x${"cc".repeat(32)}`;
const callsHash = `0x${"dd".repeat(32)}`;
const operationId = `0x${"ee".repeat(32)}`;
const zeroBytes32 = `0x${"00".repeat(32)}`;

const providerProfile = Object.freeze({
  mode: "user-rpc",
  chainId: 1,
  endpoint: "https://user-selected.rpc.example",
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
});

function createFixturePasskeySigner(events) {
  return createPasskeySigner({
    credentialId: "chrome-windows-hello-fixture",
    rpId: "localhost",
    origin: "http://localhost:8788",
    async signChallenge(challenge) {
      events.push({ type: "passkey.challenge", challenge });
      assert.equal(challenge.type, "loom.passkey-user-operation");
      assert.equal(challenge.account, account);
      assert.equal(challenge.chainId, 1);
      assert.match(challenge.intentHash, /^0x[0-9a-f]{64}$/);
      assert.match(challenge.userOperationHash, /^0x[0-9a-f]{64}$/);
      return {
        authenticatorData: "0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630500000001",
        clientDataJSON: "0x7b2274797065223a22776562617574686e2e676574227d",
        signature: "0x1234"
      };
    }
  });
}

function createInMemoryBundlerTransport(events, { allowedTarget } = {}) {
  const receipts = new Map();
  return Object.freeze({
    async sendUserOperation(envelope) {
      events.push({ type: "transport.send", envelope });
      if (allowedTarget !== undefined && envelope.intent?.calls !== undefined) {
        for (const call of envelope.intent.calls) {
          if (call.target.toLowerCase() !== allowedTarget.toLowerCase()) {
            throw new InvalidSdkRequestError("bundler simulation rejected forbidden target", {
              target: call.target
            });
          }
        }
      }
      const userOpHash = hashCanonical({
        type: "e2e.user-operation",
        userOperation: envelope.userOperation
      });
      const receipt = Object.freeze({
        userOpHash,
        success: true,
        receipt: {
          transactionHash: hashCanonical({
            type: "e2e.transaction",
            userOpHash
          }),
          logs: [
            {
              event: "UserOperationEvent",
              sender: envelope.userOperation.sender,
              account: envelope.account
            }
          ]
        }
      });
      receipts.set(userOpHash, receipt);
      return { userOpHash };
    },
    async estimateUserOperationGas(envelope) {
      events.push({ type: "transport.estimate", envelope });
      return {
        callGasLimit: 100_000n,
        verificationGasLimit: 200_000n,
        preVerificationGas: 50_000n
      };
    },
    async waitForUserOperationReceipt({ userOpHash }) {
      events.push({ type: "transport.wait", userOpHash });
      const receipt = receipts.get(userOpHash);
      if (receipt === undefined) throw new Error(`missing receipt for ${userOpHash}`);
      return receipt;
    }
  });
}

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

function createStateTransport(events, {
  recoveryConfigured = true,
  guardianRoot = `0x${"12".repeat(32)}`,
  guardianThreshold = 2n,
  configVersion = 3n,
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
  return Object.freeze({
    async ethCall(input) {
      events.push({ type: "state.ethCall", input });
      const result = responses.shift();
      if (result === undefined) throw new Error("unexpected eth_call");
      return result;
    }
  });
}

function createClient(events, options = {}) {
  return createLoomClient({
    chainId: 1,
    account,
    kohaku: {
      providerProfile,
      fetch: async url => {
        events.push({ type: "kohaku.fetch", url: String(url) });
        return new Response("{}");
      }
    },
    signer: options.signer ?? createFixturePasskeySigner(events),
    transport: options.transport ?? createInMemoryBundlerTransport(events),
    stateTransport: options.stateTransport ?? createStateTransport(events)
  });
}

test("e2e wallet engine: deploy intent, send calls, wait receipt and report capabilities", async () => {
  const events = [];
  const client = createClient(events);

  const deploy = client.prepareDeployAccount({
    factory,
    salt,
    initCode: "0x1234",
    recoveryStatus: "unprotected"
  });
  assert.equal(deploy.intent.kind, "account.deploy");
  assert.equal(deploy.review.risk, "unprotected-recovery");

  const estimate = await client.estimateCalls({
    calls: [{ target, value: 0n, data: "0x12345678" }]
  });
  assert.equal(estimate.callGasLimit, 100_000n);

  const sent = await client.sendCallsAndWait({
    calls: [{ target, value: 0n, data: "0x12345678" }]
  });
  assert.equal(sent.receipt.success, true);
  assert.equal(sent.receipt.receipt.logs[0].event, "UserOperationEvent");

  const capabilities = client.getCapabilities({ address: account, chainIds: ["0x1"] });
  assert.equal(capabilities["0x1"].atomic.status, "supported");

  assert.equal(events.filter(event => event.type === "passkey.challenge").length, 1);
  assert.equal(events.filter(event => event.type === "transport.send").length, 1);
  assert.equal(events.filter(event => event.type === "transport.wait").length, 1);
  assert.equal(events.filter(event => event.type === "kohaku.fetch").length, 0);
});

test("e2e wallet engine: wallet_sendCalls is atomic and duplicate ids are rejected", async () => {
  const events = [];
  const client = createClient(events);

  const result = await client.sendWalletCalls({
    id: "merchant-payment-1",
    version: "2.0.0",
    from: account,
    chainId: "0x1",
    atomicRequired: true,
    calls: [
      { to: target, value: "0x1", data: "0x12345678" },
      { to: token, data: "0xa9059cbb" }
    ]
  });

  assert.equal(result.id, "merchant-payment-1");
  assert.equal(result.capabilities.atomic.status, "supported");
  await assert.rejects(
    () => client.sendWalletCalls({
      id: "merchant-payment-1",
      version: "2.0.0",
      from: account,
      chainId: "0x1",
      atomicRequired: true,
      calls: [{ to: target, data: "0x12345678" }]
    }),
    /wallet_sendCalls id has already been used/
  );
});

test("e2e wallet engine: app session flow accepts allowed target and rejects forbidden target at broadcast boundary", async () => {
  const events = [];
  const client = createClient(events, {
    transport: createInMemoryBundlerTransport(events, { allowedTarget: target })
  });

  const grant = client.grantSession({
    origin: "https://merchant.example",
    sessionKey,
    target,
    selector: "0x12345678",
    token,
    maxAmount: 100n,
    validUntil: 1_000n,
    maxUses: 3
  });
  assert.equal(grant.intent.kind, "session.grant");
  assert.equal(grant.review.risk, "bounded-session");

  await client.sendCalls({
    calls: [{ target, value: 0n, data: "0x12345678" }]
  });
  await assert.rejects(
    () => client.sendCalls({
      calls: [{ target: forbiddenTarget, value: 0n, data: "0x12345678" }]
    }),
    /forbidden target/
  );

  const revoke = client.revokeSession({
    sessionKey,
    callData: "0xe89005c7"
  });
  assert.equal(revoke.intent.kind, "session.revoke");
  assert.equal(revoke.review.risk, "permission-revocation");
});

test("e2e wallet engine: recovery, migration and vault user stories are clear-signed lifecycle intents", () => {
  const events = [];
  const client = createClient(events);

  const recovery = client.proposeRecovery({
    newConfigHash: configHash,
    configVersion: 4n,
    executeAfter: 1_000n
  });
  assert.equal(recovery.intent.kind, "recovery.propose");
  assert.equal(recovery.review.requiresGuardianApproval, true);
  assert.equal(recovery.review.delayRequired, true);

  const migration = client.sdk.lifecycle.buildMigration({
    chainId: 1,
    account,
    destination,
    destinationCodeHash: codeHash,
    delaySeconds: 86_400,
    callData: "0x528833ca"
  });
  assert.equal(client.sdk.clearSigning.explainIntent(migration).risk, "account-migration");

  const migrationExecution = client.sdk.lifecycle.buildMigrationExecution({
    chainId: 1,
    account,
    migrationId: operationId,
    destination,
    destinationCodeHash: codeHash,
    destinationConfigHash: configHash,
    callsHash,
    executeAfter: 1_000n,
    expiresAt: 2_000n,
    callData: "0x"
  });
  assert.equal(client.sdk.clearSigning.explainIntent(migrationExecution).risk, "account-migration-execution");

  const recoveryExecution = client.executeRecovery({
    recoveryId: operationId,
    oldValidators: [account],
    newValidator: recipient,
    initDataHash: callsHash,
    newGuardianRoot: configHash,
    newGuardianThreshold: 2,
    executeAfter: 1_000n,
    expiresAt: 2_000n,
    callData: "0x"
  });
  assert.equal(recoveryExecution.review.risk, "account-recovery-execution");

  const vault = client.scheduleVaultWithdrawal({
    token,
    recipient,
    amount: 50n,
    executeAfter: 1_000n
  });
  assert.equal(vault.intent.kind, "vault.withdrawal.schedule");
  assert.equal(vault.review.delayRequired, true);
});

test("e2e wallet engine: walkaway broadcast can use a different transport for the same prepared intent", async () => {
  const events = [];
  const client = createClient(events);
  const prepared = client.prepareCalls({
    calls: [{ target, value: 0n, data: "0x12345678" }]
  });
  const first = await client.sendPreparedUserOperation(prepared);
  const alternateEvents = [];
  const second = await client.sendPreparedUserOperation(prepared, {
    signer: createFixturePasskeySigner(alternateEvents),
    transport: createInMemoryBundlerTransport(alternateEvents)
  });

  assert.equal(first.userOpHash, second.userOpHash);
  assert.equal(events.filter(event => event.type === "transport.send").length, 1);
  assert.equal(alternateEvents.filter(event => event.type === "transport.send").length, 1);
});

test("e2e wallet engine: no hidden default RPC, bundler or signer exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    throw new Error(`unexpected global fetch: ${String(input)}`);
  };
  try {
    const client = createLoomClient({
      chainId: 1,
      account,
      kohaku: {
        providerProfile,
        fetch: async () => new Response("{}")
      }
    });
    const prepared = client.prepareCalls({
      calls: [{ target, value: 0n, data: "0x12345678" }]
    });

    assert.equal(prepared.kind, "account.calls.prepare");
    await assert.rejects(
      () => client.sendCalls({
        calls: [{ target, value: 0n, data: "0x12345678" }]
      }),
      InvalidSdkRequestError
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("e2e wallet engine: safety state reader surfaces recovery and pending migration to wallet apps", async () => {
  const events = [];
  const client = createClient(events, {
    stateTransport: createStateTransport(events, {
      frozenUntil: 900n,
      pendingMigration: [
        addressWord(destination),
        bytes32(codeHash),
        bytes32(configHash),
        bytes32(callsHash),
        word(700n),
        word(1_200n),
        word(3n),
        word(4n)
      ],
      pendingRecovery: [
        bytes32(zeroBytes32),
        addressWord("0x0000000000000000000000000000000000000000"),
        bytes32(zeroBytes32),
        bytes32(zeroBytes32),
        word(0n),
        word(0n),
        word(0n),
        word(0n),
        word(0n)
      ]
    })
  });

  const state = await client.readSafetyState({ recoveryModule, now: 500n });
  assert.equal(state.status, "frozen");
  assert.equal(state.recoveryConfigured, true);
  assert.equal(state.pending.migration.active, true);
  assert.equal(state.pending.migration.destination, destination);
  assert.match(state.warnings.join("\n"), /Account is frozen/);
  assert.match(state.warnings.join("\n"), /Migration is pending/);
  assert.equal(events.filter(event => event.type === "state.ethCall").length, 8);
});
