import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateToolchainPins } from "./validate-toolchain-pins.mjs";

const PINNED_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

/// Builds a throwaway repository shaped like the real one. Each test starts
/// from a clean version and breaks exactly one property, so a passing
/// assertion means that rule fired rather than some unrelated failure.
function fixture({ solcVersion = "0.8.35", packageSolc = "0.8.35", workflow } = {}) {
  const base = mkdtempSync(join(tmpdir(), "loom-toolchain-pins-"));
  mkdirSync(join(base, ".github", "workflows"), { recursive: true });
  writeFileSync(join(base, "foundry.toml"), `[profile.default]\nsolc_version = "${solcVersion}"\n`);
  writeFileSync(join(base, "package.json"), JSON.stringify({ devDependencies: { solc: packageSolc } }));
  writeFileSync(
    join(base, ".github", "workflows", "ci.yml"),
    workflow ??
      `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${PINNED_SHA} # v7\n`
  );
  return base;
}

test("a clean repository shape passes every rule", () => {
  assert.deepEqual(validateToolchainPins(fixture()), []);
});

test("a second Solidity version anywhere is a failure", () => {
  const problems = validateToolchainPins(fixture({ packageSolc: "0.8.36" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pins disagree/u);
  assert.match(problems[0], /0\.8\.35/u);
  assert.match(problems[0], /0\.8\.36/u);
});

test("a caret range that resolves to the pinned version is accepted", () => {
  assert.deepEqual(validateToolchainPins(fixture({ packageSolc: "^0.8.35" })), []);
});

test("solc-select and solc binary pins are compared against foundry.toml", () => {
  const workflow = [
    "jobs:",
    "  prove:",
    "    env:",
    "      SOLC_BINARY: solc-linux-amd64-v0.8.30+commit.47b9dedd",
    "    steps:",
    "      - run: solc-select install 0.8.35",
    `      - uses: actions/checkout@${PINNED_SHA} # v7`
  ].join("\n");
  const problems = validateToolchainPins(fixture({ workflow }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /solc binary\) => 0\.8\.30/u);
});

test("an action pinned to a moving tag is a failure", () => {
  const workflow = "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v7\n";
  const problems = validateToolchainPins(fixture({ workflow }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must be pinned to a 40-character commit SHA/u);
  assert.match(problems[0], /ci\.yml:4/u);
});

test("a local composite action needs no pin", () => {
  const workflow = "jobs:\n  build:\n    steps:\n      - uses: ./.github/actions/setup\n";
  assert.deepEqual(validateToolchainPins(fixture({ workflow })), []);
});

test("piping a downloaded script into a shell is a failure", () => {
  const workflow = [
    "jobs:",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${PINNED_SHA} # v7`,
    "      - run: curl -sSfL https://example.com/install.sh | sh -s -- -y"
  ].join("\n");
  const problems = validateToolchainPins(fixture({ workflow }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /do not pipe a downloaded script into a shell/u);
});

test("fetching a script from a branch ref is a failure even without a pipe", () => {
  const workflow = [
    "jobs:",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${PINNED_SHA} # v7`,
    "      - run: curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o init.sh"
  ].join("\n");
  const problems = validateToolchainPins(fixture({ workflow }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /moving ref "master"/u);
});

test("a commit-pinned fetch of the same script is accepted", () => {
  const workflow = [
    "jobs:",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${PINNED_SHA} # v7`,
    `      - run: curl -sSfL https://raw.githubusercontent.com/leanprover/elan/${PINNED_SHA}/elan-init.sh -o init.sh`
  ].join("\n");
  assert.deepEqual(validateToolchainPins(fixture({ workflow })), []);
});
