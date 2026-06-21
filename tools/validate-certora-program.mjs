import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(file, text, message) {
  assert(read(file).includes(text), `${file}: ${message}`);
}

assert(exists("formal/certora/README.md"), "formal/certora/README.md is required");
assert(exists("formal/certora/SCOPE.md"), "formal/certora/SCOPE.md is required");
assert(exists("formal/certora/rules/README.md"), "formal/certora/rules/README.md is required");
assert(exists("formal/certora/requirements.txt"), "formal/certora/requirements.txt is required");
assert(exists("formal/certora/conf/loom-account-authority.conf"), "loom-account-authority conf is required");
assert(exists("formal/certora/conf/loom-account-initialization.conf"), "loom-account-initialization conf is required");
assert(exists("formal/certora/specs/LoomAccountAuthority.spec"), "LoomAccountAuthority CVL spec is required");
assert(exists("formal/certora/specs/LoomAccountInitialization.spec"), "LoomAccountInitialization CVL spec is required");
assert(exists("formal/certora/specs/properties.md"), "Certora properties documentation is required");

assertIncludes("formal/certora/README.md", "CVL rules are formal specifications for selected behaviors", "must state CVL claim boundary");
assertIncludes(
  "formal/certora/README.md",
  "License Boundary",
  "must document Certora CLI license boundary",
);
assertIncludes("formal/certora/SCOPE.md", "Validator count cannot become zero", "must include first authority rule group");
assertIncludes("formal/certora/SCOPE.md", "manual prover job", "must describe manual prover scope");
assertIncludes("formal/certora/rules/README.md", "Do not add placeholder rules that are not run locally", "must reject fake CVL coverage");
assertIncludes("formal/certora/requirements.txt", "certora-cli==", "must pin Certora CLI");
assertIncludes("formal/certora/conf/loom-account-authority.conf", "LoomAccountAuthority.spec", "conf must target the authority spec");
assertIncludes(
  "formal/certora/conf/loom-account-initialization.conf",
  "LoomAccountInitialization.spec",
  "conf must target the initialization spec",
);
assertIncludes("formal/certora/specs/LoomAccountAuthority.spec", "invariant validatorCountNeverZero", "must include non-zero validator invariant");
assertIncludes("formal/certora/specs/LoomAccountAuthority.spec", "rule directSetGuardianConfigCannotSucceed", "must include direct guardian config rule");
assertIncludes(
  "formal/certora/specs/LoomAccountInitialization.spec",
  "rule initializedAccountCannotBeReinitialized",
  "must include one-shot initialization rule",
);
assertIncludes("formal/certora/specs/properties.md", "Authority Boundary Properties", "must document property category");
assertIncludes(
  "formal/certora/specs/properties.md",
  "Initialization and Upgrade-Surface Properties",
  "must document initialization property category",
);
assertIncludes(".github/workflows/certora.yml", "npm run certora:program:check", "certora workflow must run readiness validation");
assertIncludes(".github/workflows/certora.yml", "--compilation_steps_only", "certora workflow must run compile-only on PRs");
assertIncludes(".github/workflows/certora.yml", "solc-select install 0.8.35", "certora workflow must pin Solidity compiler install");

const certoraWorkflow = read(".github/workflows/certora.yml");
assert(certoraWorkflow.includes("persist-credentials: false"), "certora workflow checkout must not persist credentials");
assert(certoraWorkflow.includes("certoraRun"), "certora workflow must expose a manual prover job");
assert(certoraWorkflow.includes("CERTORAKEY"), "certora workflow must use Certora secret through CERTORAKEY");
assert(certoraWorkflow.includes("if: env.CERTORAKEY != ''"), "certoraRun must be gated on configured credentials");

console.log("certora program structure ok");
