import assert from "node:assert/strict";
import test from "node:test";
import { P256RecoveryValidatorFactoryAbi, P256ValidatorAbi } from "@loom/core/abi";
import { encodeFunctionData, keccak256 } from "viem";

import { publishRecoveryValidatorWithLoomWallet, recoveryGasPayers, selectRecoveryGasPayer } from "../src/features/recovery/recoveryGasPayer.ts";
import type { AccountHandle } from "../src/types.ts";

const CHAIN_ID = 11155111;
const TARGET = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const FACTORY = "0x3333333333333333333333333333333333333333";
// The factory takes the key fields (ADR-0025), so the reviewed commitment is
// derived from the same bytes rather than passed alongside them.
const KEY = {
  x: `0x${"11".repeat(32)}`,
  y: `0x${"22".repeat(32)}`,
  rpIdHash: `0x${"33".repeat(32)}`,
  originHash: `0x${"44".repeat(32)}`,
  policyHook: "0x4444444444444444444444444444444444444444"
} as const;
const INIT_DATA_HASH = keccak256(encodeFunctionData({
  abi: P256ValidatorAbi,
  functionName: "initialize",
  args: [KEY.x, KEY.y, KEY.rpIdHash, KEY.originHash, KEY.policyHook]
}));
const DEPLOY_DATA = encodeFunctionData({
  abi: P256RecoveryValidatorFactoryAbi,
  functionName: "deploy",
  args: [TARGET, 4n, KEY.x, KEY.y, KEY.rpIdHash, KEY.originHash, KEY.policyHook]
});

function account(address: `0x${string}`, chainId = CHAIN_ID): AccountHandle {
  return {
    version: 1, kind: "recovered", id: `${chainId}:${address}`, label: "Gas wallet", account: address,
    chainId, credentialId: "0x1234", publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"44".repeat(20)}`
  };
}

const deployment = {
  chainId: CHAIN_ID, entryPoint: FACTORY, factory: FACTORY, implementation: FACTORY,
  validator: FACTORY, policyHook: FACTORY, proxyCreationCode: "0x6000",
  recoveryValidatorProvisioner: {
    address: FACTORY,
    runtimeCodeHash: `0x${"31".repeat(32)}`,
    validatorRuntimeCodeHash: `0x${"32".repeat(32)}`,
    fallbackVerifier: "0x0000000000000000000000000000000000000000"
  }
} as const;

test("only another Saved Wallet on the recovery chain is offered as a gas payer", () => {
  const candidates = recoveryGasPayers([account(TARGET), account(PAYER), account(PAYER, 1)], CHAIN_ID, TARGET.toUpperCase());
  assert.deepEqual(candidates.map(candidate => candidate.id), [`${CHAIN_ID}:${PAYER}`]);
});

test("recovery opened from a Loom wallet keeps that wallet as the preferred gas payer", () => {
  const first = account("0x4444444444444444444444444444444444444444");
  const active = account(PAYER);
  assert.equal(selectRecoveryGasPayer([first, active], active.id)?.id, active.id);
  assert.equal(selectRecoveryGasPayer([first, active], "missing")?.id, first.id);
});

test("the selected Loom wallet signs only the exact zero-value factory deployment call", async () => {
  let submitted: unknown;
  const result = await publishRecoveryValidatorWithLoomWallet({
    config: { rpcUrl: "https://rpc.example", bundlerUrl: "https://bundler.example", explorerUrl: "https://explorer.example", relayUrl: "" },
    payer: account(PAYER), recoveryAccount: TARGET, deployment,
    deploy: { to: FACTORY, data: DEPLOY_DATA, value: 0n, permissionless: true }, initDataHash: INIT_DATA_HASH,
    readCode: async address => { assert.equal(address, PAYER); return "0x6000"; },
    submit: async input => { submitted = input; return { userOpHash: `0x${"55".repeat(32)}`, transactionHash: `0x${"66".repeat(32)}` }; }
  });

  assert.equal(result.transactionHash, `0x${"66".repeat(32)}`);
  assert.deepEqual((submitted as { calls: unknown }).calls, [{ target: FACTORY, data: DEPLOY_DATA, value: 0n }]);
  assert.equal((submitted as { account: AccountHandle }).account.account, PAYER);
});

test("an undeployed, wrong-chain, or recovering account cannot pay factory gas", async () => {
  const base = {
    config: { rpcUrl: "https://rpc.example", bundlerUrl: "https://bundler.example", explorerUrl: "https://explorer.example", relayUrl: "" },
    recoveryAccount: TARGET, deployment,
    deploy: { to: FACTORY, data: DEPLOY_DATA, value: 0n, permissionless: true } as const,
    initDataHash: INIT_DATA_HASH,
    readCode: async () => "0x" as const,
    submit: async () => { throw new Error("must not submit"); }
  };
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({ ...base, payer: account(PAYER) }), /not deployed/iu);
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({ ...base, payer: account(PAYER, 1) }), /different chain/iu);
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({ ...base, payer: account(TARGET) }), /another Loom wallet/iu);
});

test("gas payer refuses a different target, account, or passkey factory call", async () => {
  const base = {
    config: { rpcUrl: "https://rpc.example", bundlerUrl: "https://bundler.example", explorerUrl: "https://explorer.example", relayUrl: "" },
    payer: account(PAYER), recoveryAccount: TARGET, deployment, initDataHash: INIT_DATA_HASH,
    readCode: async () => "0x6000" as const,
    submit: async () => { throw new Error("must not submit"); }
  };
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({
    ...base,
    deploy: { to: PAYER, data: DEPLOY_DATA, value: 0n, permissionless: true }
  }), /trusted deployment factory/u);
  const otherAccountData = encodeFunctionData({
    abi: P256RecoveryValidatorFactoryAbi,
    functionName: "deploy",
    args: [PAYER, 4n, KEY.x, KEY.y, KEY.rpIdHash, KEY.originHash, KEY.policyHook]
  });
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({
    ...base,
    deploy: { to: FACTORY, data: otherAccountData, value: 0n, permissionless: true }
  }), /reviewed account and passkey/u);

  // The key fields are what bind the passkey now, so a call that swaps one has
  // to be refused even though the account and factory are right.
  const otherKeyData = encodeFunctionData({
    abi: P256RecoveryValidatorFactoryAbi,
    functionName: "deploy",
    args: [TARGET, 4n, `0x${"99".repeat(32)}`, KEY.y, KEY.rpIdHash, KEY.originHash, KEY.policyHook]
  });
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({
    ...base,
    deploy: { to: FACTORY, data: otherKeyData, value: 0n, permissionless: true }
  }), /reviewed account and passkey/u);

  // Swapping only the policy hook keeps every key field intact, and must still
  // be refused: it is part of what the commitment covers.
  const otherHookData = encodeFunctionData({
    abi: P256RecoveryValidatorFactoryAbi,
    functionName: "deploy",
    args: [TARGET, 4n, KEY.x, KEY.y, KEY.rpIdHash, KEY.originHash, PAYER]
  });
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({
    ...base,
    deploy: { to: FACTORY, data: otherHookData, value: 0n, permissionless: true }
  }), /reviewed account and passkey/u);
});
