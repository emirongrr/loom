import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(file, text, message) {
  assert(read(file).includes(text), `${file}: ${message}`);
}

function assertWorkflowSecurityDefaults(file) {
  const source = read(file);
  assert(source.includes("permissions:"), `${file}: must declare explicit permissions`);
  assert(source.includes("contents: read"), `${file}: must default to read-only contents permission`);
  if (source.includes("actions/checkout")) {
    assert(source.includes("persist-credentials: false"), `${file}: checkout must not persist write credentials`);
  }
}

function validateContractsWorkflow() {
  const file = ".github/workflows/ci.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "npm ci",
    "npm run deps:audit",
    "npm run docs:check",
    "npm run ci:program:check",
    "npm run formal:program:check",
    "forge fmt --check",
    "forge lint --deny warnings",
    "forge build --sizes",
    'forge snapshot --force --check --tolerance 1 --no-match-contract LoomAccountInvariantTest --no-match-path "test/formal/**"',
    "npm run coverage:check",
    "slither . --fail-high",
  ]) {
    assertIncludes(file, required, `missing required contracts CI step: ${required}`);
  }
}

function validateTestWorkflow() {
  const file = ".github/workflows/test.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "forge test -vvv",
    "forge test --match-test testFuzz --fuzz-runs 2048",
    "FOUNDRY_PROFILE=ci forge test -vvv",
    "npm run account:test",
    "npm run guardian:test",
    "npm run privacy:test",
    "npm run sdk:test",
    "npm run fixtures:test",
    "npm run formal:program:test",
    "npm run ci:program:test",
  ]) {
    assertIncludes(file, required, `missing required test CI step: ${required}`);
  }
}

function validateCertoraWorkflow() {
  const file = ".github/workflows/certora.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "name: certora",
    "npm run certora:program:check",
    "Certora compile-only",
    "--compilation_steps_only",
    "solc-select install 0.8.35",
    "formal/certora/**",
    "CERTORAKEY: ${{ secrets.CERTORA_KEY }}",
  ]) {
    assertIncludes(file, required, `missing required certora workflow step: ${required}`);
  }
}

function validateFormalWorkflow() {
  const file = ".github/workflows/formal.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "Lean authority model",
    "cd formal/lean && lake build",
    'python-version: "3.12"',
    "uv tool install --python 3.12 halmos==0.3.3",
    "timeout 300s halmos --contract LoomAccountInitializationFormal",
    "timeout 300s halmos --contract LoomAccountAuthorityFormal",
    "timeout 300s halmos --contract LoomAccountExecutionFormal",
    "timeout 300s halmos --contract LoomAccountRecoveryFormal",
    "timeout 300s halmos --contract LoomAccountMigrationFormal",
  ]) {
    assertIncludes(file, required, `missing required formal CI step: ${required}`);
  }
}

function validateNightlyWorkflow() {
  const file = ".github/workflows/nightly-verification.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "workflow_dispatch:",
    'cron: "17 2 * * 0"',
    "FOUNDRY_PROFILE=deep forge test -vvv",
    "--depth 100000 --width 500000",
    "cd formal/lean && lake build",
  ]) {
    assertIncludes(file, required, `missing required nightly verification step: ${required}`);
  }
}

function validateKontrolWorkflow() {
  const file = ".github/workflows/kontrol.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "workflow_dispatch:",
    "kontrol build",
    "kontrol prove --match-test LoomAccountAuthorityFormal.test_CannotRemoveLastValidator",
    "kontrol prove --match-test LoomAccountInitializationFormal.test_InitializedAccountCannotBeReinitialized",
  ]) {
    assertIncludes(file, required, `missing required kontrol workflow step: ${required}`);
  }
}

function validateSupplyChainWorkflow() {
  const file = ".github/workflows/supply-chain.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "actions/dependency-review-action@v4",
    "fail-on-severity: high",
    "ossf/scorecard-action@v2.4.2",
    "publish_results: false",
  ]) {
    assertIncludes(file, required, `missing required supply-chain step: ${required}`);
  }
}

function validateFormalProgramInPackage() {
  const packageJson = JSON.parse(read("package.json"));
  assert(packageJson.scripts["ci:program:check"] === "node tools/validate-ci-program.mjs", "missing ci:program:check script");
  assert(
    packageJson.scripts["ci:program:test"] === "node --test tools/validate-ci-program.test.mjs",
    "missing ci:program:test script",
  );
}

validateContractsWorkflow();
validateTestWorkflow();
validateFormalWorkflow();
validateNightlyWorkflow();
validateKontrolWorkflow();
validateSupplyChainWorkflow();
validateCertoraWorkflow();
validateFormalProgramInPackage();

console.log("ci program structure ok");
