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
  assert.match(env, /EXPO_PUBLIC_LOOM_STATE_MODE=helios\n/);
  assert.match(env, /EXPO_PUBLIC_LOOM_HELIOS_EXECUTION_RPC=\n/);
  assert.match(env, /EXPO_PUBLIC_LOOM_HELIOS_CONSENSUS_RPC=\n/);
  assert.match(env, /EXPO_PUBLIC_LOOM_HELIOS_CHECKPOINT=\n/);
  assert.match(env, /EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE=\n/);
  assert.match(env, /EXPO_PUBLIC_LOOM_P256_VERIFIER=\n/);
  assert.doesNotMatch(env, /P256_FALLBACK/i);
  assert.doesNotMatch(env, /https?:\/\//);
});

test("verified state reads are Helios-first and fail closed without evidence", () => {
  const helios = read("src/verified/helios.ts");
  const stateTransport = read("src/verified/stateTransport.ts");
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(packageJson.dependencies["@a16z/helios"], "^0.11.1");
  assert.match(helios, /createHeliosProvider/);
  assert.match(helios, /waitSynced/);
  assert.match(helios, /executionRpc/);
  assert.match(helios, /consensusRpc/);
  assert.match(helios, /checkpoint/);
  assert.match(helios, /weak-subjectivity checkpoint/);
  assert.match(stateTransport, /plain RPC reads are not light-client verified/);
  assert.match(stateTransport, /verifiedState\.mode === "helios"/);
});

test("P-256 verifier mode is explicit and not fallback-first", () => {
  const environment = read("src/config/environment.ts");
  const app = read("src/app/App.tsx");

  assert.match(environment, /native-precompile/);
  assert.match(environment, /fallback-contract/);
  assert.match(environment, /EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE/);
  assert.match(app, /protocol-level native precompile/);
  assert.match(app, /audited verifier codehash/);
  assert.doesNotMatch(environment, /P256_FALLBACK/i);
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
    assert.match(contents, /expectedOrigin/i, `${label} native module must bind expected origin`);
    assert.match(contents, /webauthn\.get/i, `${label} native module must validate assertion clientData type`);
    assert.match(contents, /webauthn\.create/i, `${label} native module must validate registration clientData type`);
    assert.match(contents, /Passkey challenge must be exactly 32 bytes/i, `${label} native module must reject malformed challenges`);
    assert.match(contents, /Passkey challenge must not be all zeroes/i, `${label} native module must reject zero challenges`);
    assert.match(
      contents,
      /native build policy|Info\.plist|application metadata/i,
      `${label} native module must use native RP policy`
    );
    assert.match(contents, /user verification/i, `${label} native module must validate UV in authenticator data`);
    assert.match(contents, /halfOrder|P256_HALF_ORDER/i, `${label} native module must canonicalize P-256 signatures`);
    assert.match(contents, /credentialIdHash/i, `${label} native module must expose only credential id hash`);
    assert.doesNotMatch(contents, /"credentialId"\s+to/, `${label} native module must not return raw credential id`);
    assert.doesNotMatch(contents, /"attestationObject"\s+to/, `${label} native module must not return attestation object`);
  }
});

test("account creation refuses zero or implicit passkey registration challenges", () => {
  const flow = read("src/flows/createAccountFlow.ts");

  assert.match(flow, /registrationChallenge/);
  assert.match(flow, /passkey\.registration\.challenge\.missing/);
  assert.doesNotMatch(flow, /0000000000000000000000000000000000000000000000000000000000000000/);
});
