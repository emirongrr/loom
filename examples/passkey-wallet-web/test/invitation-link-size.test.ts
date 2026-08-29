import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createEncryptedLinkTransport } from "../src/transports/invitations.ts";

// The page provides these; the test runner needs them named.
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const ORIGIN = "https://wallet.example";
const capability = {
  format: "loom.guardian-invite", version: 1,
  capabilityId: `0x${"ab".repeat(32)}`, chainId: 11155111,
  account: "0x8A2f1487c2B30c371c0Cd2862d3B5FD05981aFc1",
  recoveryManager: "0x9569cae60f775341c0f6c8f70170d85adbfab5f8",
  guardianRoot: `0x${"31".repeat(32)}`, threshold: 2, configVersion: "1", expiresAt: 2_000_000_000,
  guardian: {
    kind: "p256", leaf: `0x${"a1".repeat(32)}`, verifier: "0x0dCf27708b5158a08E2145105827787088a7A291",
    verifierCodeHash: `0x${"c3".repeat(32)}`, keyCommitment: `0x${"b2".repeat(32)}`, salt: `0x${"d4".repeat(32)}`
  },
  proof: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`],
  integrity: { algorithm: "keccak256-canonical-json", digest: `0x${"ff".repeat(32)}` }
};

const transport = createEncryptedLinkTransport<typeof capability>({ origin: ORIGIN });

test("a link carries its capability back intact", async () => {
  const delivered = await transport.deliver(capability, { expiresAt: 2_000_000_000 });
  assert.deepEqual(await transport.receive(delivered.value), capability);
});

// Measured before the change: 2,422 characters for this capability. A link
// people paste into a message should survive being sent, quoted and wrapped.
test("a real invitation link stays close to a thousand characters", async () => {
  const delivered = await transport.deliver(capability, { expiresAt: 2_000_000_000 });
  assert.ok(delivered.value.length < 1_000, `link was ${delivered.value.length} characters`);
});

// Only the fragment is checked: the path is /guardian, which is public by
// design and says nothing about whose account it is.
test("the fragment carries nothing legible about the account it protects", async () => {
  const delivered = await transport.deliver(capability, { expiresAt: 2_000_000_000 });
  const fragment = delivered.value.slice(delivered.value.indexOf("#cap=") + 5);
  assert.ok(!fragment.includes("8A2f1487"));
  assert.ok(!fragment.includes("loom.guardian-invite"));
});

// Links already sent must keep working, or issuing the shorter ones would
// strand every guardian holding an older one.
test("a version 1 link still opens", async () => {
  const b64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  };
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", key));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ expiresAt: 2_000_000_000, payload: capability }));
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ORIGIN) }, key, plaintext
  ));
  const legacy = b64(new TextEncoder().encode(JSON.stringify({ v: 1, k: b64(rawKey), i: b64(iv), c: b64(ciphertext) })));
  assert.deepEqual(await transport.receive(`${ORIGIN}/guardian#cap=${legacy}`), capability);
});

test("a link from another origin is refused", async () => {
  const delivered = await transport.deliver(capability, { expiresAt: 2_000_000_000 });
  await assert.rejects(
    () => createEncryptedLinkTransport<typeof capability>({ origin: "https://other.example" }).receive(delivered.value),
    /origin does not match/
  );
});

test("an expired link is refused", async () => {
  const delivered = await transport.deliver(capability, { expiresAt: Math.floor(Date.now() / 1000) - 1 });
  await assert.rejects(() => transport.receive(delivered.value), /expired/);
});

test("a truncated link is refused rather than decrypted into nonsense", async () => {
  const delivered = await transport.deliver(capability, { expiresAt: 2_000_000_000 });
  await assert.rejects(() => transport.receive(delivered.value.slice(0, delivered.value.length - 40)));
});
