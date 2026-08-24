import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { P256ValidatorAbi } from "@loom/core/abi";
import {
  candidateSigned, derToRawSignature, findAccountForAssertion, webauthnSignedMessage
} from "../src/features/onboarding/passkeyDiscovery.ts";
import { findWalletsByPasskey } from "../src/features/onboarding/findWalletsByPasskey.ts";

const subtle = webcrypto.subtle;
const hex = (bytes: Uint8Array) => `0x${[...bytes].map(b => b.toString(16).padStart(2, "0")).join("")}` as const;

/** A real P-256 key, signing the way an authenticator does. */
async function authenticator() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const authenticatorData = webcrypto.getRandomValues(new Uint8Array(37));
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: "https://wallet.example" }));
  const message = await webauthnSignedMessage({ authenticatorData, clientDataJSON }, subtle);
  const rawSignature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message));
  return {
    x: hex(raw.slice(1, 33)), y: hex(raw.slice(33, 65)),
    authenticatorData, clientDataJSON, rawSignature, message,
    der: toDer(rawSignature)
  };
}

/** The DER form an authenticator actually returns. */
function toDer(raw: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array) => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const trimmed = value.slice(start);
    const body = (trimmed[0]! & 0x80) !== 0 ? Uint8Array.from([0, ...trimmed]) : trimmed;
    return Uint8Array.from([0x02, body.length, ...body]);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

const RP = `0x${"11".repeat(32)}` as const;
const ORIGIN = `0x${"22".repeat(32)}` as const;

test("the account whose published key signed is the one found", async () => {
  const device = await authenticator();
  const found = await findAccountForAssertion({
    candidates: [
      { account: `0x${"aa".repeat(20)}`, x: `0x${"00".repeat(32)}`, y: `0x${"00".repeat(32)}`, rpIdHash: RP, originHash: ORIGIN },
      { account: `0x${"bb".repeat(20)}`, x: device.x, y: device.y, rpIdHash: RP, originHash: ORIGIN }
    ],
    assertion: { credentialId: "0xaa", authenticatorData: device.authenticatorData, clientDataJSON: device.clientDataJSON, signature: device.der },
    rpIdHash: RP, originHash: ORIGIN, subtle
  });
  assert.equal(found?.account, `0x${"bb".repeat(20)}`);
});

// A key belonging to another site's account must never even be a candidate,
// whatever it would verify against.
test("a key committed to a different origin is not considered", async () => {
  const device = await authenticator();
  const found = await findAccountForAssertion({
    candidates: [{ account: `0x${"bb".repeat(20)}`, x: device.x, y: device.y, rpIdHash: RP, originHash: `0x${"99".repeat(32)}` }],
    assertion: { credentialId: "0xaa", authenticatorData: device.authenticatorData, clientDataJSON: device.clientDataJSON, signature: device.der },
    rpIdHash: RP, originHash: ORIGIN, subtle
  });
  assert.equal(found, null);
});

test("no published key matching the passkey means no account, not a guess", async () => {
  const device = await authenticator();
  const stranger = await authenticator();
  const found = await findAccountForAssertion({
    candidates: [{ account: `0x${"cc".repeat(20)}`, x: stranger.x, y: stranger.y, rpIdHash: RP, originHash: ORIGIN }],
    assertion: { credentialId: "0xaa", authenticatorData: device.authenticatorData, clientDataJSON: device.clientDataJSON, signature: device.der },
    rpIdHash: RP, originHash: ORIGIN, subtle
  });
  assert.equal(found, null);
});

// Tampering with what was signed must break the match, or the check would be
// proving nothing.
test("altered authenticator data no longer matches the key", async () => {
  const device = await authenticator();
  const altered = Uint8Array.from(device.authenticatorData);
  altered[0] = (altered[0]! ^ 0xff);
  const found = await findAccountForAssertion({
    candidates: [{ account: `0x${"bb".repeat(20)}`, x: device.x, y: device.y, rpIdHash: RP, originHash: ORIGIN }],
    assertion: { credentialId: "0xaa", authenticatorData: altered, clientDataJSON: device.clientDataJSON, signature: device.der },
    rpIdHash: RP, originHash: ORIGIN, subtle
  });
  assert.equal(found, null);
});

// DER integers are signed, so a high top bit gains a leading zero and a short
// value has to be padded back. Either mistake reads as "not your account".
test("DER signatures convert to the fixed 64 bytes, whatever their integers look like", async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const device = await authenticator();
    const raw = derToRawSignature(device.der);
    assert.equal(raw.length, 64);
    assert.deepEqual(raw, device.rawSignature);
  }
});

test("a signature that is not DER is refused rather than misread", () => {
  assert.throws(() => derToRawSignature(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), /not DER/);
});

test("a malformed candidate key is skipped, not fatal", async () => {
  const device = await authenticator();
  assert.equal(await candidateSigned({
    candidate: { x: "0xzz", y: device.y } as never,
    message: device.message, rawSignature: device.rawSignature, subtle
  }), false);
});

/**
 * A log endpoint that keeps only a recent window and answers anything older
 * with an empty list, which is what several public providers do. The failure
 * looks exactly like "there is nothing there", so these check that it is not
 * reported as one.
 */
function forgetfulReader(logs: readonly { block: bigint; log: KeySetLog }[], keepFrom: bigint) {
  return {
    getBlockNumber: async () => HEAD,
    getLogs: async (request: { fromBlock: bigint; toBlock: bigint }) => logs
      .filter(entry => entry.block >= keepFrom && entry.block >= request.fromBlock && entry.block <= request.toBlock)
      .map(entry => entry.log)
  };
}

const HEAD = 1_000_000n;
const VALIDATOR = "0x00000000000000000000000000000000000000aa" as const;
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const GUARDIAN = "0x2222222222222222222222222222222222222222" as const;

type KeySetLog = { data: `0x${string}`; topics: readonly `0x${string}`[] };

function keySet(account: `0x${string}`, x: `0x${string}`, y: `0x${string}`): KeySetLog {
  return {
    topics: [
      encodeEventTopics({ abi: P256ValidatorAbi, eventName: "KeySet" })[0] as `0x${string}`,
      `0x${"0".repeat(24)}${account.slice(2)}` as `0x${string}`
    ],
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [x, y, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`]
    )
  };
}

const KEY_A = { x: `0x${"aa".repeat(32)}` as const, y: `0x${"ab".repeat(32)}` as const };
const KEY_B = { x: `0x${"ba".repeat(32)}` as const, y: `0x${"bb".repeat(32)}` as const };

test("finding a wallet by passkey does not call an empty history a missing wallet", async () => {
  const key = await authenticator();
  const result = await findWalletsByPasskey({
    validator: VALIDATOR,
    rpId: "wallet.example",
    origin: "https://wallet.example",
    assertion: {
      credentialId: "0x00", authenticatorData: key.authenticatorData,
      clientDataJSON: key.clientDataJSON, signature: key.der
    },
    reader: forgetfulReader([], 0n),
    subtle
  });
  assert.equal(result.found, null);
  assert.match(result.unavailable ?? "", /no account history/u);
});
