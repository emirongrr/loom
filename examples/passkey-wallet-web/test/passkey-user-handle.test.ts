import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccountHandle, decodeAccountUserHandle, encodeAccountUserHandle
} from "../src/features/onboarding/passkeyUserHandle.ts";
import { credentialBackupState } from "../src/features/onboarding/accountLifecycle.ts";

const ACCOUNT_HANDLE = `0x${"55".repeat(32)}` as const;
const FACTORY = `0x${"44".repeat(20)}` as const;

test("a versioned passkey locator round-trips its chain, factory, and account handle", () => {
  const encoded = encodeAccountUserHandle(11_155_111, FACTORY, ACCOUNT_HANDLE);
  assert.equal(encoded.length, 62);
  assert.deepEqual(decodeAccountUserHandle(encoded), {
    accountHandle: ACCOUNT_HANDLE, chainId: 11_155_111, factory: FACTORY
  });
});

test("unknown, malformed, and zero account handles are rejected", () => {
  assert.equal(decodeAccountUserHandle(new Uint8Array(32)), null);
  const future = encodeAccountUserHandle(1, FACTORY, ACCOUNT_HANDLE);
  future[1] = 4;
  assert.equal(decodeAccountUserHandle(future), null);
  assert.throws(() => encodeAccountUserHandle(1, FACTORY, `0x${"00".repeat(32)}`), /handle/u);
  assert.throws(() => encodeAccountUserHandle(1, `0x${"00".repeat(20)}`, ACCOUNT_HANDLE), /factory/u);
});

test("account handle generation retries an all-zero result", () => {
  let calls = 0;
  const accountHandle = createAccountHandle({
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      calls += 1;
      const bytes = array as Uint8Array;
      bytes.fill(calls === 1 ? 0 : 0x77);
      return array;
    }
  });
  assert.equal(calls, 2);
  assert.equal(accountHandle, `0x${"77".repeat(32)}`);
});

test("WebAuthn backup flags are parsed and impossible states fail closed", () => {
  const synced = new Uint8Array(37);
  synced[32] = 0x18;
  assert.deepEqual(credentialBackupState(synced), { backupEligible: true, backedUp: true });

  const singleDevice = new Uint8Array(37);
  assert.deepEqual(credentialBackupState(singleDevice), { backupEligible: false, backedUp: false });

  const invalid = new Uint8Array(37);
  invalid[32] = 0x10;
  assert.throws(() => credentialBackupState(invalid), /backup flags/u);
  assert.throws(() => credentialBackupState(new Uint8Array(36)), /authenticator data/u);
});
