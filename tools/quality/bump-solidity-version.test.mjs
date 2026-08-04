import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { bumpSolidityVersion } from "./bump-solidity-version.mjs";

const OLD_COMMIT = "47b9dedd";
const NEW_COMMIT = "8a079791";
const OLD_SHA = "fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4";
const NEW_SHA = "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6";

/// A miniature of the real repository: one of every shape a compiler pin takes
/// here, plus two files that mention the old version for reasons a bump must
/// not disturb.
function fixture(files) {
  const base = mkdtempSync(join(tmpdir(), "loom-solc-bump-"));
  for (const [relative, contents] of Object.entries(files)) {
    const parts = relative.split("/");
    if (parts.length > 1) mkdirSync(join(base, parts.slice(0, -1).join(sep)), { recursive: true });
    writeFileSync(join(base, parts.join(sep)), contents);
  }
  return base;
}

function read(base, relative) {
  return readFileSync(join(base, relative.split("/").join(sep)), "utf8");
}

function repository() {
  return {
    "foundry.toml": '[profile.default]\nsolc_version = "0.8.35"\noptimizer = true\n',
    "package.json": '{\n  "devDependencies": {\n    "solc": "0.8.35"\n  }\n}\n',
    "src/LoomAccount.sol": "// SPDX-License-Identifier: MIT\npragma solidity 0.8.35;\n\ncontract LoomAccount {}\n",
    ".github/workflows/kontrol.yml": [
      "env:",
      `  SOLC_BINARY: solc-linux-amd64-v0.8.35+commit.${OLD_COMMIT}`,
      `  SOLC_SHA256: ${OLD_SHA}`,
      ""
    ].join("\n"),
    ".github/workflows/certora.yml": "    - run: solc-select install 0.8.35\n    - run: solc-select use 0.8.35\n",
    "tools/ci/validate-ci-program.mjs": [
      'assertIncludes(".github/workflows/certora.yml", "solc-select install 0.8.35");',
      `assertIncludes(".github/workflows/kontrol.yml", "solc-linux-amd64-v0.8.35+commit.${OLD_COMMIT}");`,
      `assertIncludes(".github/workflows/kontrol.yml", "${OLD_SHA}");`,
      ""
    ].join("\n"),
    "tools/evidence/build-deployment-manifest.mjs": '  solcVersion: "0.8.35",\n',
    "docs/operations/deployment.md": "- Solidity `0.8.35`\n",
    "tools/formal/setup-linux-provers.sh": [
      "SOLC_VERSION=0.8.35",
      `SOLC_BINARY=solc-linux-amd64-v0.8.35+commit.${OLD_COMMIT}`,
      `SOLC_SHA256=${OLD_SHA}`,
      ""
    ].join("\n")
  };
}

function bump(base, files) {
  return bumpSolidityVersion({
    base,
    from: "0.8.35",
    to: "0.8.36",
    fromCommit: OLD_COMMIT,
    toCommit: NEW_COMMIT,
    fromChecksum: OLD_SHA,
    toChecksum: NEW_SHA,
    files
  });
}

test("every pin shape in the repository moves in one sweep", () => {
  const files = repository();
  const base = fixture(files);

  const { remaining } = bump(base, Object.keys(files));

  assert.equal(read(base, "foundry.toml").includes('solc_version = "0.8.36"'), true);
  assert.equal(read(base, "package.json").includes('"solc": "0.8.36"'), true);
  assert.equal(read(base, "src/LoomAccount.sol").includes("pragma solidity 0.8.36;"), true);
  assert.equal(read(base, ".github/workflows/certora.yml").includes("solc-select install 0.8.36"), true);
  assert.equal(read(base, ".github/workflows/certora.yml").includes("solc-select use 0.8.36"), true);
  assert.equal(read(base, "tools/evidence/build-deployment-manifest.mjs").includes('solcVersion: "0.8.36"'), true);
  assert.equal(read(base, "docs/operations/deployment.md").includes("Solidity `0.8.36`"), true);
  assert.deepEqual(remaining, []);
});

test("the Kontrol binary name and its checksum move together", () => {
  const files = repository();
  const base = fixture(files);

  bump(base, Object.keys(files));

  const workflow = read(base, ".github/workflows/kontrol.yml");
  assert.equal(workflow.includes(`solc-linux-amd64-v0.8.36+commit.${NEW_COMMIT}`), true);
  assert.equal(workflow.includes(NEW_SHA), true);
  assert.equal(workflow.includes(OLD_SHA), false);
  assert.equal(workflow.includes(OLD_COMMIT), false);
});

test("the prover setup script moves as one pin, checksum included", () => {
  // A prover run that fetched a compiler this file no longer names would prove
  // properties about bytecode the repository never builds.
  const files = repository();
  const base = fixture(files);

  bump(base, Object.keys(files));

  const script = read(base, "tools/formal/setup-linux-provers.sh");
  assert.equal(script.includes("SOLC_VERSION=0.8.36"), true);
  assert.equal(script.includes(`SOLC_BINARY=solc-linux-amd64-v0.8.36+commit.${NEW_COMMIT}`), true);
  assert.equal(script.includes(`SOLC_SHA256=${NEW_SHA}`), true);
  assert.equal(script.includes("0.8.35"), false);
});

test("the validators that mirror those workflow strings move with them", () => {
  // These assertions are what makes a half-finished bump fail loudly in CI, so
  // a sweep that updated the workflow but not its validator would trade one
  // silent inconsistency for another.
  const files = repository();
  const base = fixture(files);

  bump(base, Object.keys(files));

  const validator = read(base, "tools/ci/validate-ci-program.mjs");
  assert.equal(validator.includes("solc-select install 0.8.36"), true);
  assert.equal(validator.includes(`solc-linux-amd64-v0.8.36+commit.${NEW_COMMIT}`), true);
  assert.equal(validator.includes(NEW_SHA), true);
  assert.equal(validator.includes("0.8.35"), false);
});

test("a mention outside the known pin shapes is reported, not rewritten", () => {
  // The pin gate's own test needs two disagreeing versions to have anything to
  // assert, and a decision record describes what a past release used. Rewriting
  // either would quietly destroy the thing it exists to say.
  const files = {
    ...repository(),
    "tools/quality/validate-toolchain-pins.test.mjs": 'validateToolchainPins(fixture({ packageSolc: "0.8.35" }));\n',
    "docs/decisions/0012-release-nightly-evidence.md": "The 2026-05 release was built with Solidity 0.8.35.\n"
  };
  const base = fixture(files);

  const { remaining } = bump(base, Object.keys(files));

  assert.deepEqual(
    remaining.map(entry => entry.relative).sort(),
    ["docs/decisions/0012-release-nightly-evidence.md", "tools/quality/validate-toolchain-pins.test.mjs"]
  );
  assert.equal(remaining.every(entry => entry.gateRelevant === false), true);
  assert.equal(remaining.every(entry => entry.partial === false), true);
  assert.equal(
    read(base, "tools/quality/validate-toolchain-pins.test.mjs").includes('packageSolc: "0.8.35"'),
    true
  );
  assert.equal(read(base, "docs/decisions/0012-release-nightly-evidence.md").includes("0.8.35"), true);
});

test("a file rewritten in part is separated from one left alone", () => {
  // The pin gate's own test carries a `solc-select install` line *and* a second
  // version it needs to disagree with. Moving the first leaves the fixture
  // asserting that two identical versions disagree, which is a broken test
  // rather than a leftover, so it has to be reported as its own category.
  const files = {
    ...repository(),
    "tools/quality/validate-toolchain-pins.test.mjs": [
      'fixture({ packageSolc: "0.8.35" });',
      '"      - run: solc-select install 0.8.35"',
      ""
    ].join("\n")
  };
  const base = fixture(files);

  const { remaining } = bump(base, Object.keys(files));

  assert.deepEqual(remaining, [
    { relative: "tools/quality/validate-toolchain-pins.test.mjs", gateRelevant: false, partial: true }
  ]);
});

test("a pin site the sweep could not move is flagged as gate-relevant", () => {
  // `solc_version='0.8.35'` uses single quotes, which no rule matches. The point
  // is that the leftover is named as blocking rather than passing silently: a
  // repository with two reachable compilers must never look like a clean bump.
  const files = { ...repository(), "foundry.toml": "[profile.default]\nsolc_version='0.8.35'\n" };
  const base = fixture(files);

  const { remaining } = bump(base, Object.keys(files));

  assert.deepEqual(remaining, [{ relative: "foundry.toml", gateRelevant: true, partial: false }]);
});

test("lockfiles are left for npm to regenerate", () => {
  // Editing the version beside an integrity hash only npm can recompute would
  // produce a lockfile that installs one compiler and claims another.
  const files = { ...repository(), "package-lock.json": '{ "packages": { "": { "devDependencies": { "solc": "0.8.35" } } } }\n' };
  const base = fixture(files);

  const { changed, remaining } = bump(base, Object.keys(files));

  assert.equal(read(base, "package-lock.json").includes('"solc": "0.8.35"'), true);
  assert.equal(changed.some(entry => entry.relative === "package-lock.json"), false);
  assert.deepEqual(remaining, []);
});

test("a caret range keeps its prefix", () => {
  const files = { ...repository(), "package.json": '{\n  "devDependencies": {\n    "solc": "^0.8.35"\n  }\n}\n' };
  const base = fixture(files);

  bump(base, Object.keys(files));

  assert.equal(read(base, "package.json").includes('"solc": "^0.8.36"'), true);
});

test("a file that merely discusses Solidity is untouched", () => {
  const prose = "Loom targets recent Solidity; 0.8.35 is not special beyond being the current pin.\n";
  const files = { ...repository(), "docs/design/architecture.md": prose };
  const base = fixture(files);

  bump(base, Object.keys(files));

  assert.equal(read(base, "docs/design/architecture.md"), prose);
});
