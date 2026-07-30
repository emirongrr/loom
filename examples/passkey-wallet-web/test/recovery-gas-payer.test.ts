import assert from "node:assert/strict";
import test from "node:test";

import { publishRecoveryValidatorWithLoomWallet, recoveryGasPayers, selectRecoveryGasPayer } from "../src/features/recovery/recoveryGasPayer.ts";
import type { AccountHandle } from "../src/types.ts";

const CHAIN_ID = 11155111;
const TARGET = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const FACTORY = "0x3333333333333333333333333333333333333333";

function account(address: `0x${string}`, chainId = CHAIN_ID): AccountHandle {
  return {
    version: 1, kind: "recovered", id: `${chainId}:${address}`, label: "Gas wallet", account: address,
    chainId, credentialId: "0x1234", publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"44".repeat(20)}`
  };
}

const deployment = {
  chainId: CHAIN_ID, entryPoint: FACTORY, factory: FACTORY, implementation: FACTORY,
  validator: FACTORY, policyHook: FACTORY, proxyCreationCode: "0x6000"
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
    deploy: { to: FACTORY, data: "0x1234", value: 0n, permissionless: true },
    readCode: async address => { assert.equal(address, PAYER); return "0x6000"; },
    submit: async input => { submitted = input; return { userOpHash: `0x${"55".repeat(32)}`, transactionHash: `0x${"66".repeat(32)}` }; }
  });

  assert.equal(result.transactionHash, `0x${"66".repeat(32)}`);
  assert.deepEqual((submitted as { calls: unknown }).calls, [{ target: FACTORY, data: "0x1234", value: 0n }]);
  assert.equal((submitted as { account: AccountHandle }).account.account, PAYER);
});

test("an undeployed, wrong-chain, or recovering account cannot pay factory gas", async () => {
  const base = {
    config: { rpcUrl: "https://rpc.example", bundlerUrl: "https://bundler.example", explorerUrl: "https://explorer.example", relayUrl: "" },
    recoveryAccount: TARGET, deployment,
    deploy: { to: FACTORY, data: "0x1234", value: 0n, permissionless: true } as const,
    readCode: async () => "0x" as const,
    submit: async () => { throw new Error("must not submit"); }
  };
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({ ...base, payer: account(PAYER) }), /not deployed/iu);
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({ ...base, payer: account(PAYER, 1) }), /different chain/iu);
  await assert.rejects(publishRecoveryValidatorWithLoomWallet({ ...base, payer: account(TARGET) }), /another Loom wallet/iu);
});
