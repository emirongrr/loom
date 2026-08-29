import assert from "node:assert/strict";
import test from "node:test";

import type { LoomTransportAdapter, UserOperationEnvelope } from "@loom/sdk";
import {
  authorizeSponsoredActivation,
  createSponsoredActivationTransport,
  validateSponsoredActivationEnvelope
} from "../src/features/wallet/sponsoredActivation.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const FACTORY = "0x2222222222222222222222222222222222222222";
const ENTRYPOINT = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
const FACTORY_DATA = "0x1234";
const PAYMASTER = "0x3333333333333333333333333333333333333333";
const TX = `0x${"ab".repeat(32)}`;

function deployment(fallback: "disabled" | "explicit-rejection" = "disabled") {
  return {
    schemaVersion: 2, chainId: 11155111, entryPoint: ENTRYPOINT, factory: FACTORY,
    onboardingPaymaster: PAYMASTER,
    onboarding: {
      activation: "sponsored",
      sponsorship: {
        policyId: "loom-sepolia-onboarding-v1", policyHash: `0x${"44".repeat(32)}`, maxCostWei: "1000000",
        maxFactoryDataBytes: 128, maxActivationsPerPrincipal: 3, windowSeconds: 86400,
        privateSubmission: true, publicFallback: fallback
      }
    }
  } as never;
}

function envelope(): UserOperationEnvelope {
  return {
    kind: "userOperation.prepare", chainId: 11155111, account: ACCOUNT,
    intent: {} as never, intentHash: `0x${"77".repeat(32)}`, review: {} as never,
    userOperation: {
      sender: ACCOUNT, nonce: 0n, factory: FACTORY, factoryData: FACTORY_DATA,
      callData: "0x", callGasLimit: 10n, verificationGasLimit: 20n,
      preVerificationGas: 30n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
      paymaster: PAYMASTER, paymasterVerificationGasLimit: 40n, paymasterPostOpGasLimit: 1n,
      paymasterData: "0x1234",
      signature: "0x1234"
    }
  } as never;
}

const plan = { factory: FACTORY, factoryData: FACTORY_DATA, salt: `0x${"44".repeat(32)}`, recoveryStatus: "unprotected" } as const;

test("authorization inserts the pinned paymaster before the passkey signs", async () => {
  const sponsored = await authorizeSponsoredActivation({
    endpoint: "https://relay.example", deployment: deployment(), envelope: envelope(),
    fetch: (async (_url, init) => {
      assert.equal(init?.credentials, "include");
      return new Response(JSON.stringify({
        authorized: true, paymaster: PAYMASTER,
        preVerificationGas: "0x100", paymasterVerificationGasLimit: "0x200",
        paymasterPostOpGasLimit: "0x1", paymasterData: "0x1234"
      }), { status: 200 });
    }) as typeof fetch
  });
  assert.equal(sponsored.userOperation.paymaster, PAYMASTER);
  assert.equal(sponsored.userOperation.preVerificationGas, 256n);
  assert.equal(sponsored.userOperation.paymasterVerificationGasLimit, 512n);
});

test("private sponsor result is bound to the locally computed UserOperation hash", async () => {
  let requestBody: Record<string, unknown> | undefined;
  let idempotency: string | null = null;
  const transport = createSponsoredActivationTransport({
    endpoint: "https://relay.example/private", account: ACCOUNT, plan, deployment: deployment(),
    publicTransport: { async sendUserOperation() { throw new Error("public path must not run"); } },
    fetch: (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      idempotency = new Headers(init?.headers).get("idempotency-key");
      return new Response(JSON.stringify({
        accepted: true, account: ACCOUNT,
        userOpHash: requestBody?.expectedUserOpHash,
        transactionHash: TX
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });
  const sent = await transport.sendUserOperation(envelope());
  assert.equal(sent.userOpHash, requestBody?.expectedUserOpHash);
  assert.equal(idempotency, sent.userOpHash);
  assert.equal((await transport.waitForUserOperationReceipt?.({ userOpHash: sent.userOpHash }))?.receipt.transactionHash, TX);
});

test("ambiguous private delivery never leaks the activation to the public bundler", async () => {
  let publicCalls = 0;
  const publicTransport: LoomTransportAdapter = {
    async sendUserOperation() { publicCalls += 1; return { userOpHash: `0x${"55".repeat(32)}` }; }
  };
  const transport = createSponsoredActivationTransport({
    endpoint: "https://relay.example", account: ACCOUNT, plan,
    deployment: deployment("explicit-rejection"), publicTransport,
    fetch: (async () => { throw new Error("timeout"); }) as typeof fetch
  });
  await assert.rejects(transport.sendUserOperation(envelope()), /delivery is unknown/);
  assert.equal(publicCalls, 0);
});

test("public fallback runs only after a signed policy response proves non-acceptance", async () => {
  let publicCalls = 0;
  const publicHash = `0x${"66".repeat(32)}`;
  const transport = createSponsoredActivationTransport({
    endpoint: "https://relay.example", account: ACCOUNT, plan,
    deployment: deployment("explicit-rejection"),
    publicTransport: { async sendUserOperation() { publicCalls += 1; return { userOpHash: publicHash }; } },
    fetch: (async () => new Response(JSON.stringify({
      accepted: false, delivery: "not-accepted", publicFallbackAllowed: true, reason: "quota"
    }), { status: 422 })) as typeof fetch
  });
  assert.equal((await transport.sendUserOperation(envelope())).userOpHash, publicHash);
  assert.equal(publicCalls, 1);
});

test("sponsorship refuses any first operation that also calls the account", () => {
  const original = envelope();
  const changed = { ...original, userOperation: { ...original.userOperation, callData: "0x1234" } };
  assert.throws(() => validateSponsoredActivationEnvelope({
    envelope: changed, account: ACCOUNT, plan, deployment: deployment(),
    policy: deployment().onboarding.sponsorship
  } as never), /empty first activation/);
});
