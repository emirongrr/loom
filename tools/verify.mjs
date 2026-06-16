import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";
const full = process.argv.includes("--full");

function run(name, command, args, env = {}) {
  const started = performance.now();
  console.log(`\n==> ${name}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit"
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  if (result.status !== 0) throw new Error(`${name} failed after ${seconds}s`);
  console.log(`<== ${name} passed in ${seconds}s`);
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap(name => {
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

run("WebAuthn fixture shape", process.execPath, ["tools/validate-webauthn-fixtures.mjs"]);
run("Documentation references", process.execPath, ["tools/validate-doc-links.mjs"]);
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
  "LoomAccountInvariantTest"
]);
run("Contract tests", forge, ["test"]);
if (full) run("CI fuzz and invariants", forge, ["test"], { FOUNDRY_PROFILE: "ci" });
assertExperimentalAccountCryptoAbsentFromContracts();
