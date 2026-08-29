import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "viem";
import { encodePasskeyAccountLocator } from "@loom/sdk/account-discovery";
import {
  encodeRecoveryPasskeyInitData, prepareNewRecoveryPasskey, publishRecoveryValidator
} from "../src/features/recovery/recoveryPasskey.ts";

const POLICY = "0x1111111111111111111111111111111111111111";
const FACTORY = "0x2222222222222222222222222222222222222222";
const VALIDATOR = "0x3333333333333333333333333333333333333333";
const ACCOUNT = "0x4444444444444444444444444444444444444444";
const ACCOUNT_HANDLE = `0x${"55".repeat(32)}` as const;
const USER_HANDLE = hex(encodePasskeyAccountLocator({ chainId: 11155111, factory: POLICY, accountHandle: ACCOUNT_HANDLE }));
const passkey = {
  credentialId: "0x1234",
  publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
  accountHandle: ACCOUNT_HANDLE,
  userHandle: USER_HANDLE,
  backupEligible: true,
  backedUp: true
} as const;

function deployment(provisioning = true) {
  return {
    chainId: 11155111,
    entryPoint: POLICY,
    factory: POLICY,
    implementation: POLICY,
    validator: POLICY,
    policyHook: POLICY,
    proxyCreationCode: "0x6000",
    ...(provisioning ? { recoveryValidatorProvisioner: {
      address: FACTORY,
      runtimeCodeHash: `0x${"31".repeat(32)}`,
      validatorRuntimeCodeHash: `0x${"32".repeat(32)}`,
      fallbackVerifier: "0x0000000000000000000000000000000000000000"
    } } : {})
  } as const;
}

test("unsupported deployment fails before creating a passkey", async () => {
  let registrations = 0;
  await assert.rejects(prepareNewRecoveryPasskey({
    deployment: deployment(false), label: "Recovered wallet", rpId: "localhost", origin: "http://localhost:5174", account: ACCOUNT, accountHandle: ACCOUNT_HANDLE,
    register: async () => { registrations += 1; return passkey; },
    assertUsable: async () => { throw new Error("must not run"); },
    prepare: async () => { throw new Error("must not run"); }
  }), /cannot provision/u);
  assert.equal(registrations, 0);
});

test("new passkey is bound to RP, origin, policy hook, and live factory preparation", async () => {
  let observedInitData = "";
  const order: string[] = [];
  const prepared = await prepareNewRecoveryPasskey({
    deployment: deployment(), label: "  Recovered wallet  ", rpId: "localhost", origin: "http://localhost:5174", account: ACCOUNT, accountHandle: ACCOUNT_HANDLE,
    register: async (label, accountHandle, chainId, factory, account) => {
      assert.equal(label, "Recovered wallet");
      assert.equal(accountHandle, ACCOUNT_HANDLE);
      assert.equal(factory, POLICY);
      assert.equal(account, ACCOUNT);
      assert.equal(chainId, 11155111);
      order.push("register");
      return passkey;
    },
    assertUsable: async input => {
      order.push("assert");
      assert.equal(input.passkey, passkey);
      assert.equal(input.rpId, "localhost");
      assert.equal(input.origin, "http://localhost:5174");
    },
    prepare: async ({ initData }) => {
      order.push("prepare");
      observedInitData = initData;
      return { validator: VALIDATOR, initDataHash: keccak256(initData), alreadyDeployed: false,
        deploy: { to: FACTORY, data: "0x1234", value: 0n, permissionless: true } };
    }
  });
  assert.equal(observedInitData, encodeRecoveryPasskeyInitData({ passkey, rpId: "localhost", origin: "http://localhost:5174", policyHook: POLICY }));
  assert.equal(prepared.validator, VALIDATOR);
  assert.equal(prepared.initDataHash, keccak256(prepared.initData));
  assert.deepEqual(order, ["register", "assert", "prepare"]);
});

test("an authenticator-bound credential remains usable with guardian recovery", async () => {
  let preparations = 0;
  const prepared = await prepareNewRecoveryPasskey({
    deployment: deployment(), label: "Device-only", rpId: "localhost", origin: "http://localhost:5174",
    account: ACCOUNT, accountHandle: ACCOUNT_HANDLE,
    register: async () => ({ ...passkey, backupEligible: false, backedUp: false }),
    assertUsable: async () => undefined,
    prepare: async ({ initData }) => { preparations += 1; return { validator: VALIDATOR, initDataHash: keccak256(initData), alreadyDeployed: true }; }
  });
  assert.equal(preparations, 1);
  assert.equal(prepared.passkey.backupEligible, false);
});

test("an unusable newly registered credential is rejected before validator preparation", async () => {
  let preparations = 0;
  await assert.rejects(prepareNewRecoveryPasskey({
    deployment: deployment(), label: "Recovered wallet", rpId: "localhost", origin: "http://localhost:5174",
    account: ACCOUNT, accountHandle: ACCOUNT_HANDLE,
    register: async () => passkey,
    assertUsable: async () => { throw new Error("post-registration assertion failed"); },
    prepare: async () => { preparations += 1; throw new Error("must not run"); }
  }), /post-registration assertion failed/u);
  assert.equal(preparations, 0);
});

test("a registration carrying another locator is rejected before assertion or preparation", async () => {
  let assertions = 0;
  let preparations = 0;
  await assert.rejects(prepareNewRecoveryPasskey({
    deployment: deployment(), label: "Recovered wallet", rpId: "localhost", origin: "http://localhost:5174",
    account: ACCOUNT, accountHandle: ACCOUNT_HANDLE,
    register: async () => ({ ...passkey, userHandle: hex(encodePasskeyAccountLocator({
      chainId: 11155111, factory: POLICY, accountHandle: `0x${"77".repeat(32)}`
    })) }),
    assertUsable: async () => { assertions += 1; },
    prepare: async () => { preparations += 1; throw new Error("must not run"); }
  }), /expected v3 account locator/u);
  assert.equal(assertions, 0);
  assert.equal(preparations, 0);
});

test("permissionless publication rejects the wrong chain and submits only the prepared zero-value call", async () => {
  const methods: string[] = [];
  const wrongChain = { request: async ({ method }: { method: string }) => { methods.push(method); return "0x1"; } };
  await assert.rejects(publishRecoveryValidator({ provider: wrongChain, chainId: 11155111, deploy: { to: FACTORY, data: "0x1234", value: 0n, permissionless: true } }), /switch/iu);
  // Asked to switch, then checked again rather than trusted: a wallet may
  // reject the request, or accept it and stay where it was. Sending to one that
  // never moved would put the transaction on the wrong chain.
  assert.deepEqual(methods, ["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);

  let transaction: unknown;
  const provider = { request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_requestAccounts") return [POLICY];
    transaction = params?.[0];
    return `0x${"ab".repeat(32)}`;
  } };
  const hash = await publishRecoveryValidator({ provider, chainId: 11155111, deploy: { to: FACTORY, data: "0x1234", value: 0n, permissionless: true } });
  assert.equal(hash, `0x${"ab".repeat(32)}`);
  assert.deepEqual(transaction, { from: POLICY, to: FACTORY, data: "0x1234", value: "0x0" });
});

test("a wallet that switches when asked is not refused", async () => {
  const methods: string[] = [];
  let chain = "0x1";
  const provider = { request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    methods.push(method);
    if (method === "eth_chainId") return chain;
    if (method === "wallet_switchEthereumChain") { chain = "0xaa36a7"; return null; }
    if (method === "eth_requestAccounts") return [POLICY];
    void params;
    return `0x${"cd".repeat(32)}`;
  } };
  const hash = await publishRecoveryValidator({
    provider, chainId: 11155111, deploy: { to: FACTORY, data: "0x1234", value: 0n, permissionless: true }
  });
  assert.match(hash, /^0x[0-9a-f]{64}$/u);
  assert.deepEqual(methods.slice(0, 3), ["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
});

// A wallet that accepts the request and stays put must not be sent a
// transaction: it would land on whatever chain the wallet is actually on.
test("a wallet that claims to switch but does not is still refused", async () => {
  const provider = { request: async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "wallet_switchEthereumChain") return null;
    return `0x${"ef".repeat(32)}`;
  } };
  await assert.rejects(publishRecoveryValidator({
    provider, chainId: 11155111, deploy: { to: FACTORY, data: "0x1234", value: 0n, permissionless: true }
  }), /switch/iu);
});

function hex(value: Uint8Array): `0x${string}` {
  return `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
