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
  const normalized = read(file).replace(/\s+/g, " ");
  assert(normalized.includes(text), `${file}: ${message}`);
}

function solidityFiles(relativeDir) {
  return fs
    .readdirSync(path.join(root, relativeDir))
    .filter((name) => name.endsWith(".t.sol"))
    .map((name) => path.join(relativeDir, name));
}

function validateFormalDocs() {
  assertIncludes(
    "test/formal/README.md",
    "formal-style symbolic property tests",
    "must describe the suite as symbolic property tests",
  );
  assertIncludes(
    "test/formal/README.md",
    "not complete mathematical formal verification",
    "must reject complete theorem-prover proof claims",
  );
  assertIncludes(
    "docs/security/formal-verification.md",
    "symbolic property tests",
    "must avoid overstating Halmos/Foundry evidence",
  );
  assertIncludes(
    "formal/lean/README.md",
    "must not be described as proofs of the deployed contracts",
    "must keep Lean claim boundaries explicit",
  );
  assertIncludes(
    "formal/refinement/account-authority.md",
    "Every theorem cited externally must have at least one executable Solidity",
    "must define a refinement evidence gate",
  );
}

function validateHalmosConfig() {
  const config = read("halmos.toml");
  assert(config.includes("[global]"), "halmos.toml must use the single [global] section expected by Halmos");
  assert(config.includes('match-contract = ".*Formal"'), "halmos.toml must target formal property contracts");
  assert(config.includes('function = "check_"'), "halmos.toml must target check_ symbolic properties");
  assert(!config.includes("depth = 0"), "halmos.toml must not use unbounded depth in the PR/default profile");
  assert(!config.includes("width = 0"), "halmos.toml must not use unbounded width in the PR/default profile");
}

function validateFoundryWrappers() {
  const expected = new Set([
    "check_InitializedAccountCannotBeReinitialized",
    "check_DelegatedInitializerRejectsExternalCaller",
    "check_ImmutableProxyInitializesProxyStorage",
    "check_NoMutableUpgradeSelectorsThroughProxy",
    "check_InvalidDirectExecutionDoesNotConsumeNonce",
    "check_CannotRemoveLastValidator",
    "check_FrozenAccountCannotExecute",
    "check_RecoveryDelayIsEnforced",
    "check_MigrationHashBinding",
    "check_BatchExecutionAtomicity",
    "check_GuardianCannotPerformValidatorAction",
    "check_ValidatorCannotPerformGuardianRecoveryAction",
    "check_PrivilegedAccountFunctionsRejectExternalCall",
  ]);
  const found = new Set();

  for (const file of solidityFiles("test/formal")) {
    const source = read(file);
    const checks = [...source.matchAll(/function\s+(check_[A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]);
    for (const checkName of checks) {
      found.add(checkName);
      const suffix = checkName.slice("check_".length);
      const wrapper = new RegExp(`function\\s+(test|testFuzz)_${suffix}\\s*\\(`);
      assert(wrapper.test(source), `${file}: ${checkName} must have a Foundry test_ or testFuzz_ wrapper`);
    }
  }

  for (const checkName of expected) {
    assert(found.has(checkName), `missing required symbolic property: ${checkName}`);
  }

  return found;
}

function validateRefinementMap(foundChecks) {
  const file = "formal/refinement/account-authority.md";
  const source = read(file);
  const matrixStart = source.indexOf("## Executable Refinement Matrix");
  const matrixEnd = source.indexOf("## Abstract State Mapping");
  assert(matrixStart >= 0 && matrixEnd > matrixStart, `${file}: executable refinement matrix is required`);
  const matrix = source.slice(matrixStart, matrixEnd);
  const documented = new Set(
    [...matrix.matchAll(/`(check_[A-Za-z0-9_]+)`/gu)].map((match) => match[1]),
  );

  for (const checkName of foundChecks) {
    const occurrences = matrix.split(`\`${checkName}\``).length - 1;
    assert(occurrences === 1, `${file}: ${checkName} must appear exactly once in the executable matrix`);
  }
  for (const checkName of documented) {
    assert(foundChecks.has(checkName), `${file}: stale or unknown executable property: ${checkName}`);
  }
  assert(
    documented.size === foundChecks.size,
    `${file}: executable matrix must cover the complete current symbolic property inventory`,
  );

  const lean = read("formal/lean/Loom/Authority.lean");
  const theorems = [...lean.matchAll(/\btheorem\s+([a-z][A-Za-z0-9_]*)/gu)].map((match) => match[1]);
  for (const theorem of theorems) {
    assert(source.includes(`\`${theorem}\``), `${file}: Lean theorem is not mapped: ${theorem}`);
  }

  assert(!source.includes("Pending model extension"), `${file}: stale pending-model placeholders are not allowed`);
  assert(!source.includes("Planned initialization theorem"), `${file}: stale planned-theorem placeholders are not allowed`);
}

function validateToolingPlan() {
  assert(fs.existsSync(path.join(root, "formal/kontrol/README.md")), "formal/kontrol/README.md is required");
  assert(fs.existsSync(path.join(root, "formal/kontrol/targets.json")), "formal/kontrol/targets.json is required");
  assert(fs.existsSync(path.join(root, "formal/certora/README.md")), "formal/certora/README.md is required");
  assert(fs.existsSync(path.join(root, "formal/certora/conf/loom-account-authority.conf")), "Certora conf is required");
  assert(fs.existsSync(path.join(root, "formal/certora/conf/loom-account-initialization.conf")), "Certora initialization conf is required");
  assert(fs.existsSync(path.join(root, "formal/certora/specs/LoomAccountAuthority.spec")), "Certora spec is required");
  assert(fs.existsSync(path.join(root, "formal/certora/specs/LoomAccountInitialization.spec")), "Certora initialization spec is required");
  assert(fs.existsSync(path.join(root, "formal/lean/lakefile.lean")), "formal/lean/lakefile.lean is required");
}

validateFormalDocs();
validateHalmosConfig();
const foundChecks = validateFoundryWrappers();
validateRefinementMap(foundChecks);
validateToolingPlan();

console.log("formal program structure ok");
