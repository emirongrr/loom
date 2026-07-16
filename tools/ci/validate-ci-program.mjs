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
    "npm run fixtures:check",
    "set -o pipefail",
    "npm run e2e:devnet 2>&1 | tee artifacts/devnet/devnet-lifecycle.log",
    "broadcast/DeployDevnet.s.sol/31337/run-latest.json",
    "broadcast/DevnetAccountLifecycle.s.sol/31337/run-latest.json",
    "if: always()",
    "actions/upload-artifact@v7",
    "name: devnet-${{ github.sha }}",
    "path: artifacts/devnet",
    "retention-days: 30",
    "if-no-files-found: error",
    "forge fmt --check",
    "forge lint --deny warnings",
    "forge build --sizes",
    'forge snapshot --force --check --tolerance 1 --no-match-contract ".*Formal|LoomAccount(Extended)?InvariantTest|MainnetTokenCompatibilityForkTest|MultiP256ValidatorTest|P256VerifierConfigTest|WebAuthnFixtureCorpusTest|WebAuthnEntryPointLifecycleIntegrationTest" --no-match-path "test/(formal|script)/.*"',
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
    "npm run sdk:types:check",
    "npm run fixtures:test",
    "npm run deployment:manifest:build:test",
    "npm run formal:program:test",
    "npm run ci:program:test",
    "npm run release:nightly:test",
  ]) {
    assertIncludes(file, required, `missing required test CI step: ${required}`);
  }
}

function validateCertoraWorkflow() {
  const file = ".github/workflows/certora.yml";
  assertWorkflowSecurityDefaults(file);
  assertIncludes(file, "pull_request:", "certora workflow must run on every pull request because it is branch-required");
  assert(!read(file).includes("paths:"), `${file}: branch-required certora workflow must not use pull_request paths filters`);
  for (const required of [
    "name: certora",
    "npm run certora:program:check",
    "Certora compile-only",
    "--compilation_steps_only",
    "solc-select install 0.8.35",
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
    "set -o pipefail",
    "FOUNDRY_PROFILE=deep forge test -vvv 2>&1 | tee artifacts/nightly-foundry/forge-test.log",
    "run-metadata.json",
    "if: always()",
    "actions/upload-artifact@v7",
    "name: nightly-foundry-${{ github.sha }}",
    "path: artifacts/nightly-foundry",
    "MAINNET_RPC_URL: ${{ secrets.MAINNET_RPC_URL }}",
    "npm run test:fork:tokens 2>&1 | tee artifacts/nightly-token-fork/token-matrix.log",
    "name: nightly-token-fork-${{ github.sha }}",
    "path: artifacts/nightly-token-fork",
    "critical-guard-mutations:",
    "npm run test:mutation:critical -- --report artifacts/nightly-mutation/report.json 2>&1 | tee artifacts/nightly-mutation/mutation.log",
    "name: nightly-mutation-${{ github.sha }}",
    "path: artifacts/nightly-mutation",
    'test -n "$MAINNET_RPC_URL"',
    "retention-days: 30",
    "if-no-files-found: error",
    "--depth 100000 --width 500000",
    "cd formal/lean && lake build",
  ]) {
    assertIncludes(file, required, `missing required nightly verification step: ${required}`);
  }
}

function validateReleaseWorkflow() {
  const file = ".github/workflows/release.yml";
  const source = read(file);
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    'tags:',
    '"v*"',
    "actions: read",
    "npm --prefix packages/privacy ci",
    "npm run deps:audit",
    "npm run release:nightly:check",
    "npm run verify",
    "npm run coverage:check",
    "npm run fixtures:release",
    "npm run e2e:devnet",
    "MAINNET_RPC_URL: ${{ secrets.MAINNET_RPC_URL }}",
    'test -n "$MAINNET_RPC_URL"',
    "npm run test:fork:tokens",
    "slither . --fail-high",
    "src script docs evidence fixtures out",
    "actions/upload-artifact@v7",
    "gh release create",
  ]) {
    assertIncludes(file, required, `missing required release qualification step: ${required}`);
  }
  assert(source.includes("needs: [qualification, static-analysis]"), `${file}: publishing must depend on every release qualification job`);
  assert(
    (source.match(/contents: write/gu) ?? []).length === 1,
    `${file}: only the publishing job may receive release write authority`,
  );
  assert(
    source.indexOf("contents: write") > source.indexOf("\n  publish:\n"),
    `${file}: release write authority must be scoped to the publishing job`,
  );
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
    "pkg:pypi/certora-cli",
    "pkg:npm/node-forge",
    "ossf/scorecard-action@v2.4.3",
    "publish_results: false",
  ]) {
    assertIncludes(file, required, `missing required supply-chain step: ${required}`);
  }
}

function validateDeploymentManifestCandidateWorkflow() {
  const file = ".github/workflows/deployment-manifest-candidate.yml";
  assertWorkflowSecurityDefaults(file);
  for (const required of [
    "workflow_dispatch:",
    "manifest_path:",
    "persist-credentials: false",
    "foundry-rs/foundry-toolchain@v1",
    "version: v1.7.1",
    "npm ci",
    "forge build --sizes",
    "*.local.json|*.config.json|*.config.local.json",
    "npm run deployment:manifest:check -- \"$MANIFEST_PATH\"",
  ]) {
    assertIncludes(file, required, `missing deployment manifest candidate workflow step: ${required}`);
  }
}

function validateFormalProgramInPackage() {
  const packageJson = JSON.parse(read("package.json"));
  assert(
    packageJson.scripts["ci:program:check"] === "node tools/ci/validate-ci-program.mjs",
    "missing ci:program:check script",
  );
  assert(
    packageJson.scripts["ci:program:test"] === "node --test tools/ci/validate-ci-program.test.mjs",
    "missing ci:program:test script",
  );
  assert(
    packageJson.scripts["release:nightly:test"] === "node --test tools/ci/require-recent-nightly.test.mjs",
    "missing release:nightly:test script",
  );
  assert(
    packageJson.scripts["release:nightly:check"] === "node tools/ci/require-recent-nightly.mjs",
    "missing release:nightly:check script",
  );
  assert(
    packageJson.scripts["test:mutation:critical"] === "node tools/quality/run-critical-guard-mutations.mjs",
    "missing test:mutation:critical script",
  );
  assert(
    packageJson.scripts["test:mutation:critical:self-test"] ===
      "node tools/quality/run-critical-guard-mutations.mjs --self-test",
    "missing test:mutation:critical:self-test script",
  );
}

function validateRepositoryMergePolicyDocs() {
  assertIncludes("CONTRIBUTING.md", "GitHub squash merge only", "must document squash-only pull request merging");
  assertIncludes(
    "CONTRIBUTING.md",
    "Do not add `Merge branch 'main' into ...`",
    "must document that feature branches should not merge main",
  );
  assertIncludes(
    ".github/PULL_REQUEST_TEMPLATE.md",
    "Branch history is clean",
    "pull request checklist must remind contributors to keep branch history clean",
  );
}

validateContractsWorkflow();
validateTestWorkflow();
validateFormalWorkflow();
validateNightlyWorkflow();
validateReleaseWorkflow();
validateKontrolWorkflow();
validateSupplyChainWorkflow();
validateCertoraWorkflow();
validateDeploymentManifestCandidateWorkflow();
validateFormalProgramInPackage();
validateRepositoryMergePolicyDocs();

console.log("ci program structure ok");
