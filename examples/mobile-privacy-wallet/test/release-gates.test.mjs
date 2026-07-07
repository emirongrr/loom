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

