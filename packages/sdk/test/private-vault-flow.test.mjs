import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSdkRequestError,
  createAppScopeManager,
  createLoomSdk,
  hashCanonical,
  preparePrivateVaultWithdrawal
} from "../src/index.js";
import { createKohakuHost } from "../../privacy/src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const recipient = "0x3333333333333333333333333333333333333333";
const target = "0x4444444444444444444444444444444444444444";
const vaultHook = "0x6666666666666666666666666666666666666666";

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function abi(...words) {
  return `0x${words.join("")}`;
}

function vaultPolicyTransport({ dailyLimit = 0n, period = 86400n, delay = 3600n, enabled }) {
  return {
    calls: [],
    async ethCall(input) {
      this.calls.push(input);
      return abi(word(dailyLimit), word(period), word(delay), word(enabled ? 1n : 0n));
    }
  };
}

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

function privateAdapter() {
  return {
    protocol: "railgun",
    async metadataBudget() {
      return providerProfile.metadataBudget;
    },
    async buildOperation(request) {
      return operation(request);
    },
    async shield(request) {
      return operation(request);
    },
    async unshield(request) {
      return operation(request);
    },
    async privateTransfer(request) {
      return operation(request);
    },
    async createAccount() {
      return {
        shieldedAddress: "railgun:shielded",
        metadataBudget: providerProfile.metadataBudget
      };
    },
    async broadcastPrivateOperation() {
      return {
        protocol: "railgun",
        chainId: 1,
        metadataBudget: providerProfile.metadataBudget,
        result: { id: "operation" }
      };
    }
  };
}

function operation(request) {
  return {
    protocol: "railgun",
    chainId: request.context.chainId,
    calls: [
      {
        target,
        value: 0n,
        data: "0x1234"
      }
    ],
    metadataBudget: providerProfile.metadataBudget,
    operation: {
      kind: "private-transfer",
      applicationId: request.context.applicationId,
      amount: "100"
    },
    requiresVaultDelay: true
  };
}

test("private vault preparation binds a kohaku private operation to lifecycle hashes", async () => {
  const sdk = createLoomSdk({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
  });
  const appScope = sdk.appScopes.scopeForOrigin("https://defi.example/swap");
  const prepared = await sdk.preparePrivateVaultWithdrawal({
    adapter: privateAdapter(),
    appScope,
    context: { account, chainId: 1 },
    privateRequest: { asset: token, amount: 100n, recipient: "railgun:recipient" },
    vault: {
      token,
      recipient,
      amount: 100n,
      executeAfter: 1000n
    }
  });

  assert.equal(prepared.intent.kind, "vault.privateWithdrawal.schedule");
  assert.equal(prepared.intent.privacyProtocol, "railgun");
  assert.equal(prepared.intent.privateOperationHash, prepared.hashes.privateOperationHash);
  assert.equal(prepared.intent.metadataBudgetHash, prepared.hashes.metadataBudgetHash);
  assert.equal(prepared.operation.operation.applicationId, appScope.applicationId);
  assert.equal(prepared.review.metadataBudgetRequired, true);
});

test("private vault preparation can be used independently of the full sdk object", async () => {
  const appScopes = createAppScopeManager({ chainId: 1, account });
  const appScope = appScopes.scopeForOrigin("https://pay.example");
  const prepared = await preparePrivateVaultWithdrawal({
    appScopes,
    appScope,
    adapter: privateAdapter(),
    context: { account, chainId: 1 },
    vault: {
      token,
      recipient,
      amount: "250",
      executeAfter: "1000"
    }
  });

  assert.equal(prepared.intent.amount, 250n);
  assert.equal(prepared.operation.operation.applicationId, appScope.applicationId);
});

test("private vault preparation reports unverified vault protection when no hook/transport is supplied", async () => {
  const prepared = await preparePrivateVaultWithdrawal({
    adapter: privateAdapter(),
    context: { account, chainId: 1 },
    vault: { token, recipient, amount: 100n, executeAfter: 1000n }
  });

  assert.equal(prepared.vaultProtection.verified, false);
});

test("private vault preparation verifies an enabled vault policy through the supplied state transport", async () => {
  const stateTransport = vaultPolicyTransport({ enabled: true, dailyLimit: 10n, delay: 7200n });
  const prepared = await preparePrivateVaultWithdrawal({
    adapter: privateAdapter(),
    context: { account, chainId: 1 },
    vault: { token, recipient, amount: 100n, executeAfter: 1000n, hook: vaultHook, stateTransport }
  });

  assert.equal(prepared.vaultProtection.verified, true);
  assert.equal(prepared.vaultProtection.policy.enabled, true);
  assert.equal(prepared.vaultProtection.policy.delay, 7200n);
  assert.equal(stateTransport.calls.length, 1);
  assert.equal(stateTransport.calls[0].to, vaultHook);
});

test("private vault preparation fails closed when the vault policy is not actually enabled", async () => {
  const stateTransport = vaultPolicyTransport({ enabled: false });

  await assert.rejects(
    preparePrivateVaultWithdrawal({
      adapter: privateAdapter(),
      context: { account, chainId: 1 },
      vault: { token, recipient, amount: 100n, executeAfter: 1000n, hook: vaultHook, stateTransport }
    }),
    InvalidSdkRequestError
  );
});

test("canonical hashes are stable across object key order and bigint inputs", () => {
  const first = hashCanonical({ b: 2n, a: "1" });
  const second = hashCanonical({ a: "1", b: 2n });

  assert.equal(first, second);
  assert.match(first, /^0x[0-9a-f]{64}$/);
});

test("clear signing review summarizes private vault authority", async () => {
  const sdk = createLoomSdk({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
  });
  const prepared = await sdk.preparePrivateVaultWithdrawal({
    adapter: privateAdapter(),
    context: { account, chainId: 1 },
    vault: {
      token,
      recipient,
      amount: 100n,
      executeAfter: 1000n
    }
  });

  assert.equal(prepared.review.title, "Schedule private vault withdrawal");
  assert.equal(prepared.review.delayRequired, true);
  assert.equal(prepared.review.summary.includes(prepared.hashes.privateOperationHash), true);
});
