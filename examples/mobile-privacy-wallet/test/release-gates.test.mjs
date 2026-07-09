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
  const statusScreen = read("src/screens/StatusScreen.tsx");

  assert.match(environment, /native-precompile/);
  assert.match(environment, /fallback-contract/);
  assert.match(environment, /EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE/);
  assert.match(statusScreen, /protocol-level native precompile/);
  assert.match(statusScreen, /audited verifier codehash/);
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

test("configuration fails closed instead of assuming a chain or origin", () => {
  const environment = read("src/config/environment.ts");
  const flow = read("src/flows/createAccountFlow.ts");
  const env = read(".env.example");

  // No silent mainnet / localhost / app-scheme defaults.
  assert.doesNotMatch(environment, /\?\? 1\b/);
  assert.doesNotMatch(environment, /"localhost"/);
  assert.doesNotMatch(environment, /app:\/\/loom-mobile-privacy-wallet/);
  // Missing critical values are surfaced, and account creation blocks on them.
  assert.match(environment, /export function configurationReadiness/);
  assert.match(environment, /config\.network\.chainId <= 0/);
  assert.match(flow, /configurationReadiness\(input\.config\)/);
  // Passkey relying-party binding is an explicit, documented variable.
  assert.match(env, /EXPO_PUBLIC_LOOM_RP_ID=\n/);
  assert.match(env, /EXPO_PUBLIC_LOOM_ORIGIN=\n/);
});

test("deployment addresses are verified against a committed manifest", () => {
  const manifest = read("src/loom/deployment/manifest.ts");

  assert.match(manifest, /export function parseDeploymentManifest/);
  assert.match(manifest, /export function verifyDeploymentAgainstManifest/);
  assert.match(manifest, /does not match manifest chainId/);
  assert.match(manifest, /Configured account factory does not match the manifest/);
  assert.match(manifest, /Manifest carries no code hashes/);
  // The example manifest exists and uses replaceable placeholders, not real
  // addresses that could be trusted by accident.
  const example = JSON.parse(read("deployment/manifest.example.json"));
  assert.equal(typeof example.chainId, "number");
  assert.equal(typeof example.codehashes, "object");
  assert.match(String(example.notes), /Replace every value/);
});

test("private send enforces metadata budget acknowledgment", () => {
  const flow = read("src/flows/privacySendFlow.ts");

  assert.match(flow, /metadataBudget\(context\)/);
  assert.match(flow, /privacy\.metadata-budget\.unacknowledged/);
  assert.match(flow, /privacy\.metadata-budget\.incomplete/);
  assert.match(flow, /item\.required/);
});

test("session grants are validated before reaching the client", () => {
  const flow = read("src/flows/sessionFlow.ts");

  assert.match(flow, /session\.expiry\.invalid/);
  assert.match(flow, /session\.max-amount\.invalid/);
  assert.match(flow, /session\.max-uses\.invalid/);
  assert.match(flow, /session\.key\.invalid/);
  assert.match(flow, /status: "blocked"/);
});

test("client construction cannot mint an unlabeled RPC state transport", () => {
  const client = read("src/loom/client.ts");

  assert.doesNotMatch(client, /createRpcStateTransport/);
  assert.match(client, /createMobileStateTransport/);
});

test("screen privacy native modules protect screenshots and app-switcher snapshots", () => {
  const kotlin = read(
    "modules/loom-screen-privacy/android/src/main/java/org/loom/mobileprivacywallet/screenprivacy/LoomScreenPrivacyModule.kt"
  );
  const swift = read("modules/loom-screen-privacy/ios/LoomScreenPrivacyModule.swift");
  const wrapper = read("src/platform/screenPrivacy.ts");

  assert.match(kotlin, /FLAG_SECURE/, "android module must apply FLAG_SECURE");
  assert.match(swift, /willResignActiveNotification/, "ios module must cover the app-switcher snapshot");
  assert.match(swift, /cannot block screenshots|Screenshot prevention on iOS must not be claimed/i);
  assert.match(wrapper, /Fails closed/i, "wrapper must fail closed without the native module");
});

test("local persistence is allowlisted and never names forbidden material", () => {
  const store = read("src/platform/secureStore.ts");

  assert.match(store, /SECURE_STORE_ALLOWED_KEYS/);
  assert.match(store, /credentialId\(\?\!Hash\)/, "forbidden-key pattern must reject raw credential ids");
  assert.match(store, /attestation|viewingKey|accountGraph/);
  assert.doesNotMatch(store, /@react-native-async-storage/);
});

test("clipboard hygiene clears only the value the wallet placed", () => {
  const clipboard = read("src/platform/clipboardHygiene.ts");

  assert.match(clipboard, /current === value/);
  assert.match(clipboard, /ttlMs/);
});

test("store privacy declarations exist and declare no tracking or collection", () => {
  const appJson = JSON.parse(read("app.json"));
  const dataSafety = read("docs/DATA_SAFETY.md");

  const manifests = appJson.expo.ios.privacyManifests;
  assert.equal(manifests.NSPrivacyTracking, false);
  assert.deepEqual(manifests.NSPrivacyTrackingDomains, []);
  assert.deepEqual(manifests.NSPrivacyCollectedDataTypes, []);
  assert.match(dataSafety, /Data Not Collected/);
  assert.match(dataSafety, /G-009/);
});

test("UI screens are wired to the real flows without mock paths", () => {
  const app = read("src/app/App.tsx");
  const createAccount = read("src/screens/CreateAccountScreen.tsx");
  const privateSend = read("src/screens/PrivateSendScreen.tsx");
  const gateList = read("src/components/GateList.tsx");

  assert.match(app, /CreateAccountScreen/);
  assert.match(app, /PrivateSendScreen/);
  assert.match(createAccount, /preparePasskeyAccountCreation/);
  assert.match(createAccount, /createNativePasskeyAuthenticator/);
  assert.match(createAccount, /freshChallenge/);
  assert.match(privateSend, /preparePrivateSend/);
  assert.match(privateSend, /metadataBudget/);
  assert.match(gateList, /gate\.summary/);
  for (const [label, contents] of [
    ["CreateAccountScreen", createAccount],
    ["PrivateSendScreen", privateSend]
  ]) {
    assert.equal(/\bmock\b/i.test(contents), false, `${label} must not contain mock runtime paths`);
  }
});

test("registration challenges come from the platform CSPRNG, never a constant", () => {
  const challenge = read("src/platform/challenge.ts");
  const source = read("src/platform/expoChallengeSource.ts");
  const screen = read("src/screens/CreateAccountScreen.tsx");

  assert.match(challenge, /must be exactly 32 bytes/i);
  assert.match(challenge, /must not be all zeroes/i);
  assert.match(source, /getRandomBytesAsync/);
  assert.doesNotMatch(screen, /0x[0-9a-fA-F]{64}/, "no hardcoded challenge in the screen");
});

test("runtime endpoint overrides are transport-only and validated", () => {
  const overrides = read("src/config/runtimeOverrides.ts");
  const settings = read("src/screens/SettingsScreen.tsx");

  assert.match(overrides, /bundlerUrl/);
  assert.match(overrides, /rpcUrl/);
  assert.match(overrides, /must be https or localhost/);
  assert.doesNotMatch(overrides, /accountFactory|passkeyValidator|entryPoint|chainId|rpId|origin:/,
    "runtime overrides must never touch chain identity, addresses, or passkey binding");
  assert.doesNotMatch(settings, /accountFactory|passkeyValidator|CHAIN_ID|RP_ID/,
    "the settings screen must not edit build-time identity values");
});

test("the home screen surfaces a missing Loom deployment as a first-class state", () => {
  const home = read("src/screens/HomeScreen.tsx");

  assert.match(home, /Not connected to a Loom deployment/);
  assert.match(home, /DeploySepolia\.s\.sol/);
  assert.match(home, /deploymentConnected/);
  assert.doesNotMatch(home, /\d+\.\d+ ETH(?!"?\s*:)/, "no hardcoded fake balance outside the verified branch");
});

test("connect-deployment pipeline verifies written values against the chain", () => {
  const script = read("scripts/connect-deployment.mjs");
  const connected = read("src/loom/deployment/connectedManifest.ts");
  const app = read("src/app/App.tsx");

  assert.match(script, /eth_getCode/, "the script must fetch code from the chain, not trust the broadcast");
  assert.match(script, /keccak256/, "codehashes must be computed, not copied");
  assert.match(script, /Verifying written values against the chain/);
  assert.match(script, /process\.exit\(1\)/, "verification failures must be fatal");
  assert.match(connected, /verifyDeploymentAgainstManifest/);
  assert.match(connected, /deployment\.manifest\.not-generated/);
  assert.match(app, /deploymentManifestGates/);
  assert.match(app, /manifestGates\.length === 0/, "connected state must require a matching manifest");
});

test("bootstrap and preflight guard the start path", () => {
  const bootstrap = read("scripts/bootstrap-deployment.mjs");
  const preflight = read("scripts/preflight.mjs");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(bootstrap, /required fields are empty/i, "bootstrap must list empty fields");
  assert.match(bootstrap, /connect-deployment\.mjs/, "bootstrap must run the connect+verify step");
  assert.match(bootstrap, /deployment failed — nothing was connected/i, "a failed deploy must not connect anything");
  assert.match(preflight, /NOT connected to a Loom deployment/);
  assert.match(preflight, /npm run bootstrap/, "preflight must point at the bootstrap command");
  assert.match(preflight, /LOOM_ALLOW_UNCONFIGURED/, "UI-only escape hatch must be explicit");
  assert.equal(packageJson.scripts.prestart, "node scripts/preflight.mjs");
  assert.equal(packageJson.scripts.preandroid, "node scripts/preflight.mjs");
  assert.equal(packageJson.scripts.bootstrap, "node scripts/bootstrap-deployment.mjs");
});

test("deployment lifecycle commands exist and stay honest", () => {
  const disconnect = read("scripts/disconnect-deployment.mjs");
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(packageJson.scripts["deployment:remove"], "node scripts/disconnect-deployment.mjs");
  assert.match(disconnect, /immutable and (stay|remain)/i, "must not claim on-chain contracts are deleted");
  assert.match(disconnect, /archive/i, "must archive the manifest so the deployment can be reconnected");
  assert.match(disconnect, /not-deployed/, "must reset the manifest to the placeholder");
  assert.match(disconnect, /EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY/, "must clear the deployment env fields");
});
