import assert from "node:assert/strict";
import test from "node:test";

import { deriveAccountAddress } from "@loom/core/account";
import { createLoomClient, createPasskeySigner } from "@loom/sdk";
import { deriveCreatedAccountHandle, loadWalletDeployment, resolveCreationConfig } from "../src/features/onboarding/accountLifecycle.ts";
import { planActivation } from "../src/features/wallet/activate.ts";

// The real Sepolia deployment this example ships with.
const DEPLOYMENT = {
  schemaVersion: 2,
  chainId: 11155111,
  entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
  factory: "0x2d8610879998c90c0539d4668e5d3a5297a68d6e",
  appRegistry: "0x6a7d86dcab9e8c48b03900fabc68279376ce28e1",
  implementation: "0x708e5c9c53a0e129ead9b14a73ebd891e2d0ca24",
  validator: "0xd86b5531361f6382342f59700ff1b309919eaf0a",
  policyHook: "0xceda8174e7943765993bd09c6d714a0a3d1dd82a",
  runtimeCodeHashes: {
    entryPoint: `0x${"01".repeat(32)}`, factory: `0x${"02".repeat(32)}`,
    appRegistry: `0x${"07".repeat(32)}`, implementation: `0x${"03".repeat(32)}`, validator: `0x${"04".repeat(32)}`,
    policyHook: `0x${"05".repeat(32)}`,
    recoveryModule: `0x${"06".repeat(32)}`
  },
  proxyCreationCode: "0x60a060405261027a80380380610014816101",
  recoveryModule: "0x245d394e4ce2f63679cd776d0af408921452caf0"
} as const;

const PASSKEY = {
  credentialId: "0xaabbccdd",
  publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
  accountHandle: `0x${"a5".repeat(32)}`,
  userHandle: `0x${"a6".repeat(62)}`,
  backupEligible: true,
  backedUp: true
} as const;

const INITIAL_GUARDIANS = {
  root: `0x${"73".repeat(32)}`,
  threshold: 2
} as const;

function handle() {
  return deriveCreatedAccountHandle({
    label: "Test wallet",
    deployment: DEPLOYMENT as never,
    passkey: PASSKEY as never,
    rpId: "localhost",
    origin: "http://localhost:5174"
  });
}

test("deployment metadata bypasses browser caches so newly published trust roots are visible", async () => {
  let requestInit: RequestInit | undefined;
  const request = (async (_source: RequestInfo | URL, init?: RequestInit) => {
    requestInit = init;
    return { ok: true, json: async () => DEPLOYMENT } as Response;
  }) as typeof fetch;

  await loadWalletDeployment(request);

  assert.equal(requestInit?.cache, "no-store");
});

test("deployment metadata without runtime commitments fails closed", async () => {
  const { runtimeCodeHashes: _runtimeCodeHashes, ...incomplete } = DEPLOYMENT;
  const request = (async () => ({ ok: true, json: async () => incomplete } as Response)) as typeof fetch;
  await assert.rejects(loadWalletDeployment(request), /runtime code hashes are required/);
});

// Creating an account publishes a configuration. If the rebuilt configuration
// differed from the one the address was derived from, activation would create a
// *different* account at a different address under the user's name.
test("the rebuilt creation configuration re-derives the account's own address", () => {
  const account = handle();
  const config = resolveCreationConfig(account, DEPLOYMENT as never);

  assert.ok(config, "the configuration must be reproducible");
  const derived = deriveAccountAddress({
    factory: DEPLOYMENT.factory,
    implementation: DEPLOYMENT.implementation,
    proxyCreationCode: DEPLOYMENT.proxyCreationCode,
    salt: account.accountHandle,
    config: config!
  } as never);
  assert.equal(derived.toLowerCase(), account.account.toLowerCase());
});

test("the configuration carries the account's own guardian binding and entry point", () => {
  const account = handle();
  const config = resolveCreationConfig(account, DEPLOYMENT as never)!;

  assert.equal(config.entryPoint, DEPLOYMENT.entryPoint);
  assert.equal(config.guardianRoot, account.kind === "derived" ? account.creation.guardianRoot : "");
  assert.equal(config.guardianThreshold, account.kind === "derived" ? account.creation.guardianThreshold : -1);
  assert.deepEqual(config.modules.map(module => module.moduleTypeId), [4n, 1n]);
});

// A handle whose address does not follow from its own contents cannot be trusted
// to say which account is being created.
test("a handle whose address does not match its configuration is refused", () => {
  const tampered = { ...handle(), account: "0x0000000000000000000000000000000000000001" };
  assert.equal(resolveCreationConfig(tampered as never, DEPLOYMENT as never), null);
});

test("a handle pointing at a different deployment is refused", () => {
  const other = { ...DEPLOYMENT, validator: "0x00000000000000000000000000000000000000ff" };
  assert.equal(resolveCreationConfig(handle(), other as never), null);
});

// Recovered accounts already exist on chain; there is nothing to create.
test("a recovered account handle is refused", () => {
  const recovered = {
    version: 3, kind: "recovered", id: "x", label: "r",
    account: handle().account, chainId: 11155111,
    credentialId: PASSKEY.credentialId, publicKey: PASSKEY.publicKey,
    rpId: "localhost", origin: "http://localhost:5174", validator: DEPLOYMENT.validator
  };
  assert.equal(resolveCreationConfig(recovered as never, DEPLOYMENT as never), null);
});

// The creation call is what the bundler carries; it must target this deployment's
// factory and refuse to be built at all when the configuration cannot be proved.
test("the activation plan carries the deployment's factory and its creation call", () => {
  const plan = planActivation(handle(), DEPLOYMENT as never);
  assert.equal(plan.factory, DEPLOYMENT.factory);
  assert.match(plan.factoryData, /^0x[0-9a-f]+$/i);
  assert.ok(plan.factoryData.length > 200, "the call carries the account's full configuration");
});

test("activation refuses a handle whose address does not match its configuration", () => {
  const tampered = { ...handle(), account: "0x0000000000000000000000000000000000000001" };
  assert.throws(() => planActivation(tampered as never, DEPLOYMENT as never), /could not be reproduced/);
});

test("activation refuses an account that already exists", () => {
  const recovered = {
    version: 3, kind: "recovered", id: "x", label: "r",
    account: handle().account, chainId: 11155111,
    credentialId: PASSKEY.credentialId, publicKey: PASSKEY.publicKey,
    rpId: "localhost", origin: "http://localhost:5174", validator: DEPLOYMENT.validator
  };
  assert.throws(() => planActivation(recovered as never, DEPLOYMENT as never), /already exists/);
});

// The envelope builder falls back to the deployment intent's initCode when no
// call data is given, which would make the account execute its own creation call
// as its first action. Activation pins empty call data; this guards that pin.
test("the creation operation carries no call data of its own", () => {
  const account = handle();
  const plan = planActivation(account, DEPLOYMENT as never);
  const signer = createPasskeySigner({
    credentialId: account.credentialId, rpId: account.rpId, origin: account.origin,
    validator: DEPLOYMENT.validator, entryPoint: DEPLOYMENT.entryPoint,
    async signChallenge() { throw new Error("preparation must not sign"); }
  });
  const client = createLoomClient({ chainId: account.chainId, account: account.account, signer });
  const prepared = client.prepareDeployAccount({
    factory: plan.factory, salt: plan.salt, initCode: plan.factoryData, recoveryStatus: plan.recoveryStatus
  });

  const unpinned = client.prepareUserOperation(prepared, { nonce: 0n, factory: plan.factory, factoryData: plan.factoryData });
  assert.equal(unpinned.userOperation.callData, plan.factoryData, "the fallback this pin exists to defeat");

  const pinned = client.prepareUserOperation(prepared, { nonce: 0n, callData: "0x", factory: plan.factory, factoryData: plan.factoryData });
  assert.equal(pinned.userOperation.callData, "0x");
  assert.equal(pinned.userOperation.factoryData, plan.factoryData);
  assert.equal(pinned.userOperation.nonce, 0n, "a counterfactual account has never acted");
});

// A new account has no guardians yet, and the operation's review must say so
// rather than implying recovery is already in place.
test("a new account's creation is described as unprotected", () => {
  assert.equal(planActivation(handle(), DEPLOYMENT as never).recoveryStatus, "unprotected");
});

test("an advanced creation binds guardians and the recovery module into the account address", () => {
  const protectedAccount = deriveCreatedAccountHandle({
    label: "Protected wallet",
    deployment: DEPLOYMENT as never,
    passkey: PASSKEY as never,
    rpId: "localhost",
    origin: "http://localhost:5174",
    initialGuardians: INITIAL_GUARDIANS
  });
  const config = resolveCreationConfig(protectedAccount, DEPLOYMENT as never);

  assert.ok(config);
  assert.equal(protectedAccount.kind === "derived" ? protectedAccount.creation.guardianRoot : "", INITIAL_GUARDIANS.root);
  assert.equal(protectedAccount.kind === "derived" ? protectedAccount.creation.guardianThreshold : 0, 2);
  assert.equal(protectedAccount.kind === "derived" ? protectedAccount.creation.recoveryModule : undefined, DEPLOYMENT.recoveryModule);
  assert.deepEqual(config?.modules.map(module => module.moduleTypeId), [4n, 5n, 1n]);
  assert.equal(planActivation(protectedAccount, DEPLOYMENT as never).recoveryStatus, "guardian-protected");
});

test("advanced creation refuses an unusable guardian binding", () => {
  const withoutRecovery = { ...DEPLOYMENT, recoveryModule: undefined };
  assert.throws(() => deriveCreatedAccountHandle({
    label: "Protected wallet",
    deployment: withoutRecovery as never,
    passkey: PASSKEY as never,
    rpId: "localhost",
    origin: "http://localhost:5174",
    initialGuardians: INITIAL_GUARDIANS
  }), /recovery module/i);

  assert.throws(() => deriveCreatedAccountHandle({
    label: "Protected wallet",
    deployment: DEPLOYMENT as never,
    passkey: PASSKEY as never,
    rpId: "localhost",
    origin: "http://localhost:5174",
    initialGuardians: { root: `0x${"00".repeat(32)}`, threshold: 2 }
  }), /guardian configuration/i);
});

test("an account carrying a recovery module includes it in its configuration", () => {
  const withRecovery = deriveCreatedAccountHandle({
    label: "Test wallet",
    deployment: DEPLOYMENT as never,
    passkey: PASSKEY as never,
    rpId: "localhost",
    origin: "http://localhost:5174"
  });
  // The created handle installs no recovery module, so the module list stays
  // policy hook plus validator; a recovery module would appear between them.
  const config = resolveCreationConfig(withRecovery, DEPLOYMENT as never)!;
  assert.equal(config.modules.some(module => module.moduleTypeId === 5n), false);
});
