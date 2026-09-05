import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { verifyBrowserAuthentication } from "../src/features/onboarding/accountLifecycle.ts";
import type { AccountHandle } from "../src/types.ts";

test("wallet entry verifies the selected passkey assertion and rejects a different challenge", async () => {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const challenge = webcrypto.getRandomValues(new Uint8Array(32));
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge: base64Url(challenge),
    origin: "http://localhost:5174",
    crossOrigin: false
  }));
  const rpIdHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode("localhost")));
  const authenticatorData = concat(rpIdHash, new Uint8Array([0x05, 0, 0, 0, 0]));
  const clientHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", clientDataJSON));
  const rawSignature = new Uint8Array(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    concat(authenticatorData, clientHash)
  ));
  const handle = {
    version: 3,
    kind: "derived",
    id: "wallet",
    label: "Wallet",
    account: `0x${"11".repeat(20)}`,
    chainId: 11155111,
    credentialId: "0xcafe",
    publicKey: { x: hex(base64UrlBytes(jwk.x!)), y: hex(base64UrlBytes(jwk.y!)) },
    rpId: "localhost",
    origin: "http://localhost:5174",
    accountHandle: `0x${"22".repeat(32)}`,
    creation: { guardianRoot: `0x${"00".repeat(32)}`, guardianThreshold: 0, migrationModule: null }
  } as AccountHandle;
  const assertion = { credentialId: new Uint8Array([0xca, 0xfe]), authenticatorData, clientDataJSON, signature: der(rawSignature) };

  await verifyBrowserAuthentication(handle, challenge, assertion, webcrypto);
  await assert.rejects(
    verifyBrowserAuthentication(handle, new Uint8Array(32), assertion, webcrypto),
    /challenge/
  );
});

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; }
  return output;
}

function der(raw: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array) => {
    let first = 0;
    while (first < value.length - 1 && value[first] === 0) first += 1;
    const body = value.slice(first);
    const encoded = body[0]! & 0x80 ? concat(new Uint8Array([0]), body) : body;
    return concat(new Uint8Array([0x02, encoded.length]), encoded);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

function base64Url(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function base64UrlBytes(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, "base64url")); }
function hex(value: Uint8Array): `0x${string}` { return `0x${Buffer.from(value).toString("hex")}`; }
