import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("runtime code does not include mock wallet flows", () => {
  const sourceFiles = [
    "src/flows/createAccountFlow.ts",
    "src/flows/privacySendFlow.ts",
    "src/platform/passkey/nativePasskey.ts"
  ];

  for (const file of sourceFiles) {
    const contents = read(file);
    assert.equal(/\bmock\b/i.test(contents), false, `${file} must not contain mock runtime paths`);
  }
});

test("private send is gated by Railgun release evidence", () => {
  const contents = read("src/flows/privacySendFlow.ts");
  assert.match(contents, /privacy\.railgun\.disabled/);
  assert.match(contents, /releaseGate\.status !== "passed"/);
});

test("configuration does not contain default RPC or bundler endpoints", () => {
  const env = read(".env.example");
  assert.match(env, /EXPO_PUBLIC_LOOM_RPC_URL=\n/);
  assert.match(env, /EXPO_PUBLIC_LOOM_BUNDLER_URL=\n/);
  assert.doesNotMatch(env, /https?:\/\//);
});

test("native passkey modules enforce platform verification and do not expose raw credentials", () => {
  const ios = read("modules/loom-passkey/ios/LoomPasskeyModule.swift");
  const android = read(
    "modules/loom-passkey/android/src/main/java/org/loom/mobileprivacywallet/passkey/LoomPasskeyModule.kt"
  );

  for (const [label, contents] of [
    ["ios", ios],
    ["android", android]
  ]) {
    assert.doesNotMatch(contents, /not implemented/i, `${label} native module must not be a stub`);
    assert.match(contents, /userVerification/i, `${label} native module must require user verification`);
    assert.match(contents, /credentialIdHash/i, `${label} native module must expose only credential id hash`);
    assert.doesNotMatch(contents, /"credentialId"\s+to/, `${label} native module must not return raw credential id`);
    assert.doesNotMatch(contents, /"attestationObject"\s+to/, `${label} native module must not return attestation object`);
  }
});
