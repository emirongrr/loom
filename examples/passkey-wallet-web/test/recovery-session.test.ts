import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryRequest, createRecoveryResponse } from "@loom/sdk/recovery";
import {
  createRecoverySession, createRecoverySessionRepository, transitionRecoverySession, type RecoverySession
} from "../src/features/recovery/recoverySession.ts";
import type { EncryptedStore } from "../src/storage/encryptedStore.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x2222222222222222222222222222222222222222";
const NOW = 1_900_000_000_000;

function request(idByte = "91") {
  return createRecoveryRequest({
    requestId: `0x${idByte.repeat(32)}`,
    chainId: 11155111,
    account: ACCOUNT,
    recoveryManager: MANAGER,
    guardianRoot: `0x${"31".repeat(32)}`,
    guardianThreshold: 2,
    configVersion: "9",
    nonce: "4",
    newValidator: "0x8888888888888888888888888888888888888888",
    initDataHash: `0x${"41".repeat(32)}`,
    newGuardianRoot: `0x${"51".repeat(32)}`,
    newGuardianThreshold: 2,
    createdAt: NOW / 1000,
    expiresAt: NOW / 1000 + 86_400
  });
}

function response(input: ReturnType<typeof request>, leafByte: string) {
  return createRecoveryResponse({
    requestId: input.requestId,
    chainId: input.chainId,
    account: input.account,
    recoveryDigest: `0x${"61".repeat(32)}`,
    guardianLeaf: `0x${leafByte.repeat(32)}`,
    verifier: "0x3333333333333333333333333333333333333333",
    keyCommitment: `0x${"81".repeat(32)}`,
    salt: `0x${"82".repeat(32)}`,
    proof: [],
    signature: "0x1234",
    signedAt: NOW / 1000 + 10,
    expiresAt: input.expiresAt
  });
}

test("recovery session enforces the request, quorum, delay, and execution lifecycle", () => {
  const protocol = request();
  let session = createRecoverySession(protocol, NOW);
  session = transitionRecoverySession(session, { type: "response-added", response: response(protocol, "71") }, NOW + 1);
  assert.equal(session.stage, "collecting");
  session = transitionRecoverySession(session, { type: "response-added", response: response(protocol, "72") }, NOW + 2);
  assert.equal(session.stage, "ready-to-propose");
  assert.throws(() => transitionRecoverySession(session, { type: "completed", transactionHash: `0x${"ef".repeat(32)}` }, NOW + 3), /cannot apply/u);
  session = transitionRecoverySession(session, { type: "proposal-confirmed", transactionHash: `0x${"ab".repeat(32)}`, readyAt: 100n, expiresAt: 200n }, NOW + 3);
  session = transitionRecoverySession(session, { type: "chain-ready" }, NOW + 4);
  session = transitionRecoverySession(session, { type: "completed", transactionHash: `0x${"cd".repeat(32)}` }, NOW + 5);
  assert.equal(session.stage, "completed");
  assert.equal(session.executionTransactionHash, `0x${"cd".repeat(32)}`);
});

test("corrupt and invalid recovery records cannot hide healthy sessions", async () => {
  const healthy = createRecoverySession(request("91"), NOW);
  const other = createRecoverySession(request("92"), NOW + 10);
  const values = [
    { key: "corrupt", value: undefined, corrupt: true },
    { key: healthy.id, value: healthy, corrupt: false },
    { key: "invalid", value: { version: 1 }, corrupt: false },
    { key: other.id, value: other, corrupt: false }
  ];
  const store: EncryptedStore = {
    async entries() { return values; },
    async put() {},
    async remove() {}
  };
  const snapshot = await createRecoverySessionRepository(store).inspect();
  assert.deepEqual(snapshot.sessions.map(item => item.id), [other.id, healthy.id]);
  assert.deepEqual(snapshot.issues.map(item => [item.key, item.reason]), [["corrupt", "corrupt"], ["invalid", "invalid"]]);
});

test("a response for another request and duplicate guardian responses fail closed", () => {
  const protocol = request();
  const other = request("93");
  const session = createRecoverySession(protocol, NOW);
  assert.throws(
    () => transitionRecoverySession(session, { type: "response-added", response: response(other, "71") }, NOW + 1),
    /does not match/u
  );
  const collecting = transitionRecoverySession(session, { type: "response-added", response: response(protocol, "71") }, NOW + 1);
  assert.throws(
    () => transitionRecoverySession(collecting, { type: "response-added", response: response(protocol, "71") }, NOW + 2),
    /duplicated/u
  );
});

test("session quorum and completion evidence come from the request and verified lifecycle", () => {
  const protocol = request();
  const collecting = transitionRecoverySession(createRecoverySession(protocol, NOW), { type: "response-added", response: response(protocol, "71") }, NOW + 1);
  assert.equal(collecting.stage, "collecting");
  assert.throws(() => transitionRecoverySession({ ...collecting, stage: "ready-to-propose" }, { type: "cancelled" }, NOW + 2), /approval quorum/u);
  assert.throws(() => transitionRecoverySession({ ...collecting, stage: "delay-active" }, { type: "chain-ready" }, NOW + 2), /proposal evidence/u);
  assert.throws(() => transitionRecoverySession({ ...collecting, stage: "completed" }, { type: "cancelled" }, NOW + 2), /proposal evidence|execution transaction/u);
});

test("device-local recovery material stays with the encrypted session but outside the portable request", () => {
  const protocol = request();
  const session = createRecoverySession(protocol, NOW, {
    recoveryPasskeyVerified: true,
    initData: "0x1234",
    credentialId: "0xabcd",
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"12".repeat(32)}` },
    rpId: "localhost",
    origin: "http://localhost:5174",
    oldValidators: ["0x8888888888888888888888888888888888888888"],
    freshGuardianEntries: [{
      id: "guardian-1",
      label: "Guardian 1",
      descriptor: {
        kind: "ecdsa",
        address: "0x4444444444444444444444444444444444444444",
        verifier: "0x3333333333333333333333333333333333333333",
        verifierCodeHash: `0x${"81".repeat(32)}`,
        salt: `0x${"82".repeat(32)}`
      }
    }]
  });
  assert.equal(session.local?.credentialId, "0xabcd");
  assert.deepEqual(session.local?.oldValidators, ["0x8888888888888888888888888888888888888888"]);
  assert.equal(Object.hasOwn(session.request, "local"), false);
  assert.throws(() => createRecoverySession(protocol, NOW, { ...session.local!, initData: "not-hex" as never }), /init data/u);
  assert.throws(() => createRecoverySession(protocol, NOW, {
    ...session.local!, recoveryPasskeyVerified: undefined as never
  }), /possession was not verified/u);
});
