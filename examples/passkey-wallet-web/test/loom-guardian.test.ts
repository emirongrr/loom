import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hex } from "@loom/core";
import { detectGuardianAddress, resolveLoomP256Guardian, type LoomGuardianChainReader } from "../src/features/security/loomGuardian.ts";
import type { WalletDeployment } from "../src/features/onboarding/accountLifecycle.ts";

const ACCOUNT = "0x73E1Fc60aB8b5F31a36a640d1f8035E99cE8192C" as Address;
const FACTORY = "0x1111111111111111111111111111111111111111" as Address;
const VALIDATOR = "0x2222222222222222222222222222222222222222" as Address;
const RECOVERED = "0x3333333333333333333333333333333333333333" as Address;
const VERIFIER = "0x4444444444444444444444444444444444444444" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const CODE_HASH = `0x${"aa".repeat(32)}` as Hex;
const CHILD_HASH = `0x${"bb".repeat(32)}` as Hex;
const X = `0x${"01".repeat(32)}` as Hex;
const Y = `0x${"02".repeat(32)}` as Hex;
const RP = `0x${"03".repeat(32)}` as Hex;
const ORIGIN = `0x${"04".repeat(32)}` as Hex;

const deployment = {
  chainId: 11155111, entryPoint: FACTORY, factory: FACTORY, implementation: FACTORY,
  validator: VALIDATOR, policyHook: FACTORY, proxyCreationCode: "0x01" as Hex,
  guardianVerifiers: { p256: VERIFIER },
  recoveryValidatorProvisioner: { address: FACTORY, runtimeCodeHash: CODE_HASH, validatorRuntimeCodeHash: CHILD_HASH, fallbackVerifier: ZERO }
} satisfies WalletDeployment;

function reader(overrides: Partial<LoomGuardianChainReader> = {}): LoomGuardianChainReader {
  return {
    isRegisteredAccount: async () => true,
    accountCode: async () => "0x01",
    supportsERC1271: async () => "compatible",
    validatorCount: async () => 1n,
    validatorAt: async () => VALIDATOR,
    validatorCodeHash: async () => CODE_HASH,
    validatorPublicKey: async () => [X, Y, RP, ORIGIN],
    validatorFallbackVerifier: async () => ZERO,
    guardianVerifierFallbackVerifier: async () => ZERO,
    ...overrides
  };
}

test("guardian addresses are classified from chain state without a user-selected type", async () => {
  assert.deepEqual(
    await detectGuardianAddress(ACCOUNT, reader({ accountCode: async () => { throw new Error("must not read code for Loom accounts"); } })),
    { kind: "loom", address: ACCOUNT }
  );
  assert.deepEqual(
    await detectGuardianAddress(ACCOUNT, reader({
      isRegisteredAccount: async () => false,
      accountCode: async () => "0x"
    })),
    { kind: "ecdsa", address: ACCOUNT }
  );
  assert.deepEqual(
    await detectGuardianAddress(ACCOUNT, reader({ isRegisteredAccount: async () => false, accountCode: async () => "0x6000", supportsERC1271: async () => "compatible" })),
    {
      kind: "erc1271",
      address: ACCOUNT,
      warning: "Warning: this contract returned an ERC-1271-shaped rejection, but an invalid-signature probe cannot prove that valid signatures will work. Confirm ERC-1271 support before relying on it for recovery."
    }
  );
});

test("a deployed contract carries a warning when ERC-1271 cannot be verified on chain", async () => {
  const detected = await detectGuardianAddress(ACCOUNT, reader({
    isRegisteredAccount: async () => false,
    accountCode: async () => "0x6000",
    supportsERC1271: async () => "inconclusive"
  }));
  assert.equal(detected.kind, "erc1271");
  assert.match(detected.warning ?? "", /ERC-1271 support could not be verified/u);
});

test("a contract accepting an invalid ERC-1271 probe is rejected", async () => {
  await assert.rejects(detectGuardianAddress(ACCOUNT, reader({
    isRegisteredAccount: async () => false,
    accountCode: async () => "0x6000",
    supportsERC1271: async () => "unsafe"
  })), /accepted an invalid ERC-1271 probe/u);
});

test("guardian address detection rejects invalid input", async () => {
  await assert.rejects(detectGuardianAddress("not-an-address", reader()), /valid guardian address/u);
});

test("a factory-registered Loom wallet resolves to its direct P-256 guardian authority", async () => {
  const descriptor = await resolveLoomP256Guardian({ value: ACCOUNT, deployment, verifierCodeHash: CODE_HASH, reader: reader() });
  assert.deepEqual(descriptor, { kind: "p256", publicKey: { x: X, y: Y }, verifier: VERIFIER, verifierCodeHash: CODE_HASH });
  assert.equal("account" in descriptor, false);
});

test("a pinned recovery-validator child can provide the Loom guardian key", async () => {
  const descriptor = await resolveLoomP256Guardian({ value: ACCOUNT, deployment, verifierCodeHash: CODE_HASH, reader: reader({
    validatorAt: async () => RECOVERED,
    validatorCodeHash: async () => CHILD_HASH
  }) });
  assert.equal(descriptor.kind, "p256");
});

test("unregistered or spoofed Loom addresses fail closed", async () => {
  await assert.rejects(resolveLoomP256Guardian({ value: ACCOUNT, deployment, verifierCodeHash: CODE_HASH, reader: reader({ isRegisteredAccount: async () => false }) }), /not a Loom wallet/u);
  await assert.rejects(resolveLoomP256Guardian({ value: ACCOUNT, deployment, verifierCodeHash: CODE_HASH, reader: reader({ validatorAt: async () => RECOVERED, validatorCodeHash: async () => CODE_HASH }) }), /no trusted active P-256/u);
});

test("missing, ambiguous, or verifier-incompatible P-256 keys fail closed", async () => {
  await assert.rejects(resolveLoomP256Guardian({ value: ACCOUNT, deployment, verifierCodeHash: CODE_HASH, reader: reader({ validatorPublicKey: async () => [X, Y, `0x${"00".repeat(32)}`, ORIGIN] }) }), /no trusted active P-256/u);
  await assert.rejects(resolveLoomP256Guardian({ value: ACCOUNT, deployment, verifierCodeHash: CODE_HASH, reader: reader({ validatorFallbackVerifier: async () => FACTORY }) }), /no trusted active P-256/u);
  await assert.rejects(resolveLoomP256Guardian({ value: ACCOUNT, deployment, verifierCodeHash: CODE_HASH, reader: reader({
    validatorCount: async () => 2n,
    validatorAt: async (_account, index) => index === 0n ? VALIDATOR : RECOVERED,
    validatorCodeHash: async () => CHILD_HASH,
    validatorPublicKey: async (validator) => validator === VALIDATOR ? [X, Y, RP, ORIGIN] : [`0x${"05".repeat(32)}`, Y, RP, ORIGIN]
  }) }), /more than one active P-256 key/u);
});
