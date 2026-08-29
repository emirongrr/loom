import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  decryptRoster, encryptRoster, parseEncryptedRoster, passphraseProblem, RosterTransferError
} from "../src/features/security/portableRoster.ts";

const subtle = webcrypto.subtle;
const ACCOUNT = "0x8A2f1487c2B30c371c0Cd2862d3B5FD05981aFc1";
const CHAIN = 11155111;
const backup = { entries: [{ id: "g1", label: "Ada" }], threshold: 1 };
const secret = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(9);

const seal = (key: Parameters<typeof encryptRoster>[0]["key"], over: Record<string, unknown> = {}) =>
  encryptRoster({ backup, account: ACCOUNT, chainId: CHAIN, key, subtle, ...over });

test("a passkey-locked backup opens with the same passkey secret", async () => {
  const file = await seal({ kind: "passkey", secret });
  assert.equal(file.protectedBy, "passkey");
  assert.deepEqual(await decryptRoster({ file, account: ACCOUNT, chainId: CHAIN, key: { kind: "passkey", secret }, subtle }), backup);
});

// The guardian list is the most sensitive thing this wallet holds. It must not
// be legible in the file that carries it between devices.
test("the guardians are not readable in the file", async () => {
  const file = await seal({ kind: "passkey", secret });
  assert.ok(!JSON.stringify(file).includes("Ada"));
});

test("a different passkey does not open it", async () => {
  const file = await seal({ kind: "passkey", secret });
  await assert.rejects(
    () => decryptRoster({ file, account: ACCOUNT, chainId: CHAIN, key: { kind: "passkey", secret: other }, subtle }),
    /does not open this backup/
  );
});

// The file says what unlocks it, so the reader is asked for the right thing
// rather than told the wrong thing failed.
test("a passkey file asked for a passphrase says so, without trying", async () => {
  const file = await seal({ kind: "passkey", secret });
  await assert.rejects(
    () => decryptRoster({ file, account: ACCOUNT, chainId: CHAIN, key: { kind: "passphrase", passphrase: "correct horse battery" }, subtle }),
    /unlocked by the account's passkey/
  );
});

test("an authenticator without PRF can still fall back to a passphrase", async () => {
  const file = await seal({ kind: "passphrase", passphrase: "correct horse battery" });
  assert.equal(file.protectedBy, "passphrase");
  assert.ok(file.iterations >= 100_000);
  assert.deepEqual(
    await decryptRoster({ file, account: ACCOUNT, chainId: CHAIN, key: { kind: "passphrase", passphrase: "correct horse battery" }, subtle }),
    backup
  );
});

// Refused before the secret is tried, so the reason is the real one.
test("a backup for another account is refused by name", async () => {
  const file = await seal({ kind: "passkey", secret });
  await assert.rejects(
    () => decryptRoster({ file, account: "0x1111111111111111111111111111111111111111", chainId: CHAIN, key: { kind: "passkey", secret }, subtle }),
    /different account/
  );
  await assert.rejects(
    () => decryptRoster({ file, account: ACCOUNT, chainId: 1, key: { kind: "passkey", secret }, subtle }),
    /different chain/
  );
});

// The account and chain are authenticated with the ciphertext, so relabelling
// the file for another account breaks the decryption rather than succeeding.
test("relabelling the file does not make it open elsewhere", async () => {
  const file = await seal({ kind: "passkey", secret });
  const relabelled = { ...file, account: "0x1111111111111111111111111111111111111111" };
  await assert.rejects(
    () => decryptRoster({ file: relabelled, account: "0x1111111111111111111111111111111111111111", chainId: CHAIN, key: { kind: "passkey", secret }, subtle }),
    /does not open this backup/
  );
});

// A passphrase file naming a trivial work factor would decrypt fine and
// protect nothing.
test("a passphrase backup declaring a trivial cost is refused", async () => {
  const file = await seal({ kind: "passphrase", passphrase: "correct horse battery" });
  assert.throws(() => parseEncryptedRoster({ ...file, iterations: 10 }), RosterTransferError);
});

test("a short passphrase is refused before anything is written", async () => {
  assert.match(passphraseProblem("short") ?? "", /at least 12/);
  await assert.rejects(() => seal({ kind: "passphrase", passphrase: "short" }), /at least 12/);
});

test("a passkey secret that is too short is refused rather than stretched", async () => {
  await assert.rejects(() => seal({ kind: "passkey", secret: new Uint8Array(8) }), /too short/);
});

test("a file that does not say what unlocks it is refused", () => {
  assert.throws(() => parseEncryptedRoster({
    format: "loom.guardian-roster.encrypted", version: 1, kdf: "HKDF-SHA256",
    iterations: 0, salt: "aa", iv: "bb", ciphertext: "cc", account: ACCOUNT, chainId: CHAIN
  }), /does not say what unlocks it/);
});
