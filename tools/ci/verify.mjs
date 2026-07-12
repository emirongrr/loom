import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const full = process.argv.includes("--full");
const npmCache = join(root, ".tmp", "npm-cache");
mkdirSync(npmCache, { recursive: true });

function run(name, command, args, env = {}) {
  const started = performance.now();
  console.log(`\n==> ${name}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, npm_config_cache: npmCache, ...env },
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    stdio: "inherit"
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  if (result.status !== 0) throw new Error(`${name} failed after ${seconds}s`);
  console.log(`<== ${name} passed in ${seconds}s`);
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    if (name.startsWith(".")) return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

function assertExperimentalAccountCryptoAbsentFromContracts() {
  const roots = ["src", "test", "formal", "fixtures", "script"];
  const pattern = /post.?quantum|quantum|ML.?DSA|SLH.?DSA|\bPQ\b/i;
  const violations = roots.flatMap(name =>
    sourceFiles(join(root, name))
      .filter(path => !path.endsWith("verify.mjs"))
      .filter(path => pattern.test(readFileSync(path, "utf8")))
  );
  if (violations.length !== 0) {
    throw new Error(`experimental account crypto found in contract scope:\n${violations.join("\n")}`);
  }
  console.log("\n==> Contract source policy\n<== Contract source policy passed");
}

function assertNoHardcodedPrivacyOrRpcDefaults() {
  const packageRoots = ["packages/account", "packages/guardian", "packages/privacy", "packages/sdk"];
  const pattern = /https?:\/\/(?!rpc\.example|pay\.example|defi\.example)\S+|\binfura\b|\balchemy\b|\bankr\b|\bquicknode\b|\bdrpc\b|\bllamarpc\b|cloudflare-eth/i;
  const violations = packageRoots.flatMap(name =>
    sourceFiles(join(root, name, "src"))
      .filter(path => pattern.test(readFileSync(path, "utf8")))
  );
  if (violations.length !== 0) {
    throw new Error(`hardcoded privacy/RPC default found in SDK source:\n${violations.join("\n")}`);
  }
  console.log("\n==> No hardcoded privacy/RPC defaults\n<== No hardcoded privacy/RPC defaults passed");
}

run("WebAuthn fixture shape", process.execPath, ["tools/evidence/validate-webauthn-fixtures.mjs"]);
run("WebAuthn fixture parser tests", process.execPath, [
  "--test",
  "tools/evidence/validate-webauthn-fixtures.test.mjs"
]);
run("Wallet engine E2E tests", process.execPath, ["--test", "test/e2e/wallet-engine.e2e.test.mjs"]);
run("CI program structure", process.execPath, ["tools/ci/validate-ci-program.mjs"]);
run("CI program structure tests", process.execPath, ["--test", "tools/ci/validate-ci-program.test.mjs"]);
run("Certora program structure", process.execPath, ["tools/formal/validate-certora-program.mjs"]);
run("Certora program structure tests", process.execPath, ["--test", "tools/formal/validate-certora-program.test.mjs"]);
run("Kontrol program structure", process.execPath, ["tools/formal/validate-kontrol-program.mjs"]);
run("Kontrol program structure tests", process.execPath, ["--test", "tools/formal/validate-kontrol-program.test.mjs"]);
run("Formal program structure", process.execPath, ["tools/formal/validate-formal-program.mjs"]);
run("Formal program structure tests", process.execPath, ["--test", "tools/formal/validate-formal-program.test.mjs"]);
run("Documentation references", process.execPath, ["tools/quality/validate-doc-links.mjs"]);
run("Website checks", process.execPath, ["tools/site/validate-site.mjs"]);
run("Bundler qualification evidence tests", process.execPath, [
  "--test",
  "tools/evidence/validate-bundler-qualification.test.mjs"
]);
run("Bundler smoke preflight tests", process.execPath, ["--test", "tools/evidence/bundler-smoke.test.mjs"]);
run("Coverage gate self-test", process.execPath, ["tools/quality/check-coverage-gate.mjs", "--self-test"]);
run("Deployment manifest evidence tests", process.execPath, [
  "--test",
  "tools/evidence/validate-deployment-manifest.test.mjs"
]);
run("Deployment manifest builder tests", process.execPath, [
  "--test",
  "tools/evidence/build-deployment-manifest.test.mjs"
]);
run("Wallet deployment toolkit tests", process.execPath, [
  "--test",
  "packages/deployment/test/wallet-app-deployment.test.mjs"
]);
run("Keystore proof profile tests", process.execPath, [
  "--test",
  "tools/evidence/validate-keystore-proof-profile.test.mjs"
]);
run("Live rehearsal evidence tests", process.execPath, ["--test", "tools/evidence/validate-live-rehearsal.test.mjs"]);
run("Kohaku stack evidence tests", process.execPath, ["--test", "tools/evidence/validate-kohaku-stack.test.mjs"]);
run("Kohaku stack evidence", process.execPath, ["tools/evidence/validate-kohaku-stack.mjs"]);
run("Privacy adapter profile tests", process.execPath, [
  "--test",
  "tools/evidence/validate-privacy-adapter-profile.test.mjs"
]);
run("Core SDK tests", npm, ["run", "core:test"]);
run("User-operation hash fixture", npm, ["run", "sdk:userop-hash:test"]);
run("Deployment manifest schema", npm, ["run", "manifest:schema:test"]);
run("Account SDK tests", npm, ["--prefix", "packages/account", "test"]);
run("Guardian SDK tests", npm, ["--prefix", "packages/guardian", "test"]);
run("Privacy SDK tests", npm, ["--prefix", "packages/privacy", "test"]);
run("Wallet engine SDK install", npm, ["--prefix", "packages/sdk", "ci"]);
run("Wallet engine SDK tests", npm, ["--prefix", "packages/sdk", "test"]);
run("SDK type integrity", npm, ["run", "sdk:types:check"]);
run("Formatting", forge, ["fmt", "--check"]);
run("Solidity lint", forge, ["lint", "--deny", "warnings"]);
run("Production size", forge, ["build", "--sizes", "--skip", "test/**", "script/**"]);
run("Gas snapshot", forge, [
  "snapshot",
  "--force",
  "--check",
  "--tolerance",
  "1",
  "--no-match-contract",
  ".*Formal|LoomAccount(Extended)?InvariantTest|MultiP256ValidatorTest|P256VerifierConfigTest|WebAuthnFixtureCorpusTest|WebAuthnEntryPointLifecycleIntegrationTest",
  "--no-match-path",
  "test/(formal|script)/.*"
]);
run("Contract tests", forge, ["test"]);
if (full) run("CI fuzz and invariants", forge, ["test"], { FOUNDRY_PROFILE: "ci" });
assertExperimentalAccountCryptoAbsentFromContracts();
assertNoHardcodedPrivacyOrRpcDefaults();
