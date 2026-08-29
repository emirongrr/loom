import assert from "node:assert/strict";
import test from "node:test";

import { getUserOpHash, LoomAccountFactoryAbi, packUserOperation } from "@loom/core";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import {
  authenticateSponsorRequest,
  createSponsorUsageLedger,
  parseActivationRequest,
  parseAuthorizationRequest,
  sponsorPolicyFromEnv
} from "../sponsor-policy.mjs";

const FACTORY = "0x2222222222222222222222222222222222222222";
const ENTRYPOINT = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
const SENDER = "0x1111111111111111111111111111111111111111";
const PAYMASTER = "0x3333333333333333333333333333333333333333";
const POLICY_HASH = keccak256(stringToHex("loom-sepolia-onboarding-v1"));

function policy() {
  return {
    policyId: "loom-sepolia-onboarding-v1", chainId: 11155111,
    entryPoint: ENTRYPOINT, factory: FACTORY, paymaster: PAYMASTER, policyHash: POLICY_HASH,
    paymasterVerificationGasLimit: 150000n, paymasterPostOpGasLimit: 1n, preVerificationGasBuffer: 50000n,
    referenceLoopback: true,
    maxCostWei: 1_000_000n, maxGlobalCostWei: 2_000_000n,
    maxFactoryDataBytes: 8192, maxSignatureBytes: 4096,
    maxActivationsPerPrincipal: 2, windowSeconds: 60
  };
}

function activationRequest() {
  const base = request();
  const rpc = base.userOperation;
  const op = {
    ...rpc,
    nonce: BigInt(rpc.nonce), callGasLimit: BigInt(rpc.callGasLimit),
    verificationGasLimit: BigInt(rpc.verificationGasLimit), preVerificationGas: BigInt(rpc.preVerificationGas),
    maxFeePerGas: BigInt(rpc.maxFeePerGas), maxPriorityFeePerGas: BigInt(rpc.maxPriorityFeePerGas),
    paymaster: PAYMASTER, paymasterVerificationGasLimit: 150000n, paymasterPostOpGasLimit: 1n,
    paymasterData: "0x1234" as const
  };
  const expectedUserOpHash = getUserOpHash(packUserOperation(op), ENTRYPOINT, 11155111n);
  const quantity = (value: bigint) => `0x${value.toString(16)}`;
  return {
    ...base, expectedUserOpHash,
    userOperation: {
      ...rpc, paymaster: PAYMASTER,
      paymasterVerificationGasLimit: quantity(op.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: quantity(op.paymasterPostOpGasLimit), paymasterData: op.paymasterData
    }
  };
}

function request() {
  const factoryData = encodeFunctionData({
    abi: LoomAccountFactoryAbi, functionName: "createAccount",
    args: [`0x${"11".repeat(32)}`, `0x${"00".repeat(32)}`, 0, `0x${"22".repeat(32)}`, []]
  });
  const op = {
    sender: SENDER, nonce: 0n, factory: FACTORY, factoryData, callData: "0x" as const,
    callGasLimit: 10n, verificationGasLimit: 20n, preVerificationGas: 30n,
    maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, signature: "0x1234" as const
  };
  const hash = getUserOpHash(packUserOperation(op), ENTRYPOINT, 11155111n);
  const quantity = (value: bigint) => `0x${value.toString(16)}`;
  return {
    policyId: policy().policyId, policyHash: POLICY_HASH, chainId: 11155111, entryPoint: ENTRYPOINT,
    factory: FACTORY, paymaster: PAYMASTER, expectedUserOpHash: hash,
    userOperation: {
      ...op, nonce: quantity(op.nonce), callGasLimit: quantity(op.callGasLimit),
      verificationGasLimit: quantity(op.verificationGasLimit), preVerificationGas: quantity(op.preVerificationGas),
      maxFeePerGas: quantity(op.maxFeePerGas), maxPriorityFeePerGas: quantity(op.maxPriorityFeePerGas)
    }
  };
}

test("policy accepts only an empty account-creation authorization request", () => {
  const parsed = parseAuthorizationRequest(request(), policy());
  assert.equal(parsed.op.sender, SENDER);
  assert.equal(parsed.maximumCost, 120n);
  assert.equal(parsed.userOpHash, request().expectedUserOpHash);
  assert.equal(parseAuthorizationRequest({
    ...request(), userOperation: { ...request().userOperation, signature: "0x" }
  }, policy()).op.signature, "0x");

  assert.throws(() => parseAuthorizationRequest({
    ...request(), userOperation: { ...request().userOperation, callData: "0x1234" }
  }, policy()), /empty nonce-zero/);
  assert.throws(() => parseAuthorizationRequest({
    ...request(), userOperation: { ...request().userOperation, paymaster: SENDER }
  }, policy()), /already carries a paymaster/);
});

test("final activation is bound to the authorized paymaster and canonical UserOperation hash", () => {
  assert.equal(parseActivationRequest(activationRequest(), policy()).userOpHash, activationRequest().expectedUserOpHash);
  assert.throws(() => parseActivationRequest({
    ...activationRequest(), expectedUserOpHash: `0x${"99".repeat(32)}`
  }, policy()), /hash does not match/);
  assert.throws(() => parseActivationRequest({
    ...activationRequest(), userOperation: { ...activationRequest().userOperation, signature: "0x" }
  }, policy()), /signature size/);
});

test("usage ledger enforces principal quota, global budget, release, and idempotency", () => {
  let now = 1_000;
  const ledger = createSponsorUsageLedger({ ...policy(), maxGlobalCostWei: 200n, maxActivationsPerPrincipal: 1 }, () => now);
  const first = ledger.reserve({ principal: "alice", userOpHash: `0x${"01".repeat(32)}`, maximumCost: 120n });
  assert.equal(first.duplicate, false);
  assert.throws(() => ledger.reserve({ principal: "alice", userOpHash: `0x${"02".repeat(32)}`, maximumCost: 1n }), /quota/);
  assert.throws(() => ledger.reserve({ principal: "bob", userOpHash: `0x${"03".repeat(32)}`, maximumCost: 120n }), /global/);
  ledger.commit(`0x${"01".repeat(32)}`, { accepted: true });
  assert.deepEqual(ledger.reserve({ principal: "alice", userOpHash: `0x${"01".repeat(32)}`, maximumCost: 120n }), {
    duplicate: true, result: { accepted: true }
  });
  now += 61_000;
  const second = ledger.reserve({ principal: "alice", userOpHash: `0x${"02".repeat(32)}`, maximumCost: 1n });
  ledger.release(second.reservation);
  assert.equal(ledger.snapshot().globalReserved, 120n);
});

test("the in-memory reference relay cannot bind externally", () => {
  const baseEnv = { SPONSOR_FACTORY: FACTORY, SPONSOR_PAYMASTER: PAYMASTER, SPONSOR_POLICY_HASH: POLICY_HASH };
  assert.throws(() => sponsorPolicyFromEnv(baseEnv, {
    host: "0.0.0.0", chainId: 11155111, entryPoint: ENTRYPOINT, allowedOrigin: "https://wallet.example"
  }), /loopback-only/);
  const local = sponsorPolicyFromEnv(baseEnv, {
    host: "127.0.0.1", chainId: 11155111, entryPoint: ENTRYPOINT, allowedOrigin: "http://localhost:5174"
  });
  assert.equal(authenticateSponsorRequest({}, local), "loopback-development");
});
