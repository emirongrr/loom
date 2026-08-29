import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountDiscoveryError,
  createAccountHandle,
  decodePasskeyAccountLocator,
  discoverPasskeyAccount,
  encodePasskeyAccountLocator,
  lookupAccountForHandle,
  passkeyBackupState,
  readAccountHandle,
  verifyPasskeyAssertion
} from "../dist/accountDiscovery.js";
import { LoomAccountAbi, LoomAccountFactoryAbi, P256ValidatorAbi, base64UrlEncode } from "@loom/core";
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  sha256,
  stringToHex
} from "viem";

const chainId = 11155111;
const factory = "0x1111111111111111111111111111111111111111";
const account = "0x2222222222222222222222222222222222222222";
const validator = "0x3333333333333333333333333333333333333333";
const handle = `0x${"44".repeat(32)}`;
const zeroAddress = `0x${"00".repeat(20)}`;
const rpId = "wallet.example";
const origin = "https://wallet.example";
const challenge = `0x${"55".repeat(32)}`;

test("v3 account locator round-trips chain, factory, and handle", () => {
  const encoded = encodePasskeyAccountLocator({ chainId, factory, accountHandle: handle });
  assert.equal(encoded.length, 62);
  assert.deepEqual(decodePasskeyAccountLocator(encoded), {
    version: 3, chainId, factory, accountHandle: handle
  });
  const future = encoded.slice();
  future[1] = 4;
  assert.equal(decodePasskeyAccountLocator(future), null);
  assert.throws(() => encodePasskeyAccountLocator({ chainId, factory, accountHandle: `0x${"00".repeat(32)}` }), /zero/u);
});

test("account handles are non-zero random bytes", () => {
  let calls = 0;
  const result = createAccountHandle({ getRandomValues(bytes) {
    calls += 1;
    bytes.fill(calls === 1 ? 0 : 0x7a);
    return bytes;
  } });
  assert.equal(calls, 2);
  assert.equal(result, `0x${"7a".repeat(32)}`);
});

test("registry lookup supports both directions and fails closed on RPC disagreement", async () => {
  const state = transport({ resolvedAccount: account });
  assert.equal(await lookupAccountForHandle({ factory, accountHandle: handle, stateTransport: state }), account);
  assert.equal(await readAccountHandle({ factory, account, stateTransport: state }), handle);

  await assert.rejects(
    lookupAccountForHandle({
      factory,
      accountHandle: handle,
      stateTransport: state,
      verificationStateTransport: transport({ resolvedAccount: validator })
    }),
    issue => issue instanceof AccountDiscoveryError && issue.code === "RPC_DISAGREEMENT"
  );
});

test("discovery grants active only when the assertion verifies against a live validator", async () => {
  const fixture = await assertionFixture();
  const state = transport({ resolvedAccount: account, publicKey: fixture.publicKey });
  const active = await discoverPasskeyAccount({
    chainId, factory, rpId, origin, challenge,
    assertion: fixture.assertion,
    stateTransport: state
  });
  assert.equal(active.status, "active");
  assert.equal(active.account, account);
  assert.equal(active.validator, validator);

  const staleFixture = await assertionFixture();
  const stale = await discoverPasskeyAccount({
    chainId, factory, rpId, origin, challenge,
    assertion: staleFixture.assertion,
    stateTransport: state
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.account, account);
});

test("wrong deployments, invalid ceremonies, and unactivated handles are distinct", async () => {
  const fixture = await assertionFixture();
  const wrongDeployment = await discoverPasskeyAccount({
    chainId: 1, factory, rpId, origin, challenge,
    assertion: fixture.assertion,
    stateTransport: transport({ resolvedAccount: account, publicKey: fixture.publicKey })
  });
  assert.deepEqual(wrongDeployment, { status: "invalid", reason: "deployment" });

  const invalidAssertion = await discoverPasskeyAccount({
    chainId, factory, rpId, origin, challenge: `0x${"99".repeat(32)}`,
    assertion: fixture.assertion,
    stateTransport: transport({ resolvedAccount: account, publicKey: fixture.publicKey })
  });
  assert.deepEqual(invalidAssertion, { status: "invalid", reason: "assertion" });

  const unactivated = await discoverPasskeyAccount({
    chainId, factory, rpId, origin, challenge,
    assertion: fixture.assertion,
    stateTransport: transport({ resolvedAccount: zeroAddress, publicKey: fixture.publicKey })
  });
  assert.equal(unactivated.status, "not-activated");
});

test("backup flags expose recovery portability without treating it as authority", () => {
  const synced = new Uint8Array(37);
  synced[32] = 0x18;
  assert.deepEqual(passkeyBackupState(synced), { backupEligible: true, backedUp: true });
  const impossible = new Uint8Array(37);
  impossible[32] = 0x10;
  assert.throws(() => passkeyBackupState(impossible), /backup flags/u);
});

test("post-registration verification binds user handle, ceremony, and new P-256 key", async () => {
  const fixture = await assertionFixture();
  assert.deepEqual(await verifyPasskeyAssertion({
    rpId, origin, challenge,
    expectedUserHandle: fixture.assertion.userHandle,
    publicKey: fixture.publicKey,
    assertion: fixture.assertion
  }), { valid: true });

  assert.deepEqual(await verifyPasskeyAssertion({
    rpId, origin, challenge,
    expectedUserHandle: `0x${"99".repeat(62)}`,
    publicKey: fixture.publicKey,
    assertion: fixture.assertion
  }), { valid: false, reason: "user-handle" });

  assert.deepEqual(await verifyPasskeyAssertion({
    rpId, origin, challenge: `0x${"98".repeat(32)}`,
    expectedUserHandle: fixture.assertion.userHandle,
    publicKey: fixture.publicKey,
    assertion: fixture.assertion
  }), { valid: false, reason: "ceremony" });

  const other = await assertionFixture();
  assert.deepEqual(await verifyPasskeyAssertion({
    rpId, origin, challenge,
    expectedUserHandle: fixture.assertion.userHandle,
    publicKey: other.publicKey,
    assertion: fixture.assertion
  }), { valid: false, reason: "signature" });
});

test("an unreadable validator or impossible validator count never becomes stale", async () => {
  const fixture = await assertionFixture();
  await assert.rejects(discoverPasskeyAccount({
    chainId, factory, rpId, origin, challenge,
    assertion: fixture.assertion,
    stateTransport: transport({ resolvedAccount: account })
  }), issue => issue instanceof AccountDiscoveryError && issue.code === "UNAVAILABLE");
  await assert.rejects(discoverPasskeyAccount({
    chainId, factory, rpId, origin, challenge,
    assertion: fixture.assertion,
    stateTransport: transport({ resolvedAccount: account, publicKey: fixture.publicKey, validatorCount: 0n })
  }), issue => issue instanceof AccountDiscoveryError && issue.code === "INVALID_ACCOUNT_STATE");
});

function transport({ resolvedAccount, publicKey, validatorCount = 1n }) {
  return {
    async ethCall({ to, data }) {
      if (to.toLowerCase() === factory) {
        const call = decodeFunctionData({ abi: LoomAccountFactoryAbi, data });
        if (call.functionName === "accountForHandle") {
          return encodeFunctionResult({ abi: LoomAccountFactoryAbi, functionName: call.functionName, result: resolvedAccount });
        }
        if (call.functionName === "handleForAccount") {
          return encodeFunctionResult({ abi: LoomAccountFactoryAbi, functionName: call.functionName, result: handle });
        }
      }
      if (to.toLowerCase() === account) {
        const call = decodeFunctionData({ abi: LoomAccountAbi, data });
        if (call.functionName === "validatorCount") {
          return encodeFunctionResult({ abi: LoomAccountAbi, functionName: call.functionName, result: validatorCount });
        }
        if (call.functionName === "validatorAt") {
          return encodeFunctionResult({ abi: LoomAccountAbi, functionName: call.functionName, result: validator });
        }
      }
      if (to.toLowerCase() === validator && publicKey) {
        const call = decodeFunctionData({ abi: P256ValidatorAbi, data });
        if (call.functionName === "publicKeys") {
          return encodeFunctionResult({
            abi: P256ValidatorAbi,
            functionName: call.functionName,
            result: [publicKey.x, publicKey.y, publicKey.rpIdHash, publicKey.originHash]
          });
        }
      }
      throw new Error(`unexpected eth_call to ${to}`);
    }
  };
}

async function assertionFixture() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const x = base64UrlHex(jwk.x);
  const y = base64UrlHex(jwk.y);
  const rpIdHash = sha256(stringToHex(rpId));
  const originHash = keccak256(stringToHex(origin));
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(hexBytes(rpIdHash));
  authenticatorData[32] = 0x05;
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge: base64UrlEncode(challenge),
    origin,
    crossOrigin: false
  }));
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const signed = new Uint8Array(authenticatorData.length + clientHash.length);
  signed.set(authenticatorData);
  signed.set(clientHash, authenticatorData.length);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
  const userHandle = hex(encodePasskeyAccountLocator({ chainId, factory, accountHandle: handle }));
  return {
    publicKey: { x, y, rpIdHash, originHash },
    assertion: {
      credentialId: "0x1234",
      userHandle,
      authenticatorData: hex(authenticatorData),
      clientDataJSON: hex(clientDataJSON),
      signature: hex(signature)
    }
  };
}

function base64UrlHex(value) {
  return hex(Uint8Array.from(Buffer.from(value, "base64url")));
}

function hexBytes(value) {
  return Uint8Array.from(value.slice(2).match(/.{2}/g).map(pair => Number.parseInt(pair, 16)));
}

function hex(value) {
  return `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
