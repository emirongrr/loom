import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateDocConstants, contractConstants } from "./validate-doc-constants.mjs";

/// Builds a throwaway tree with one contract and one document, so each test
/// changes exactly one side of the pair.
function fixture({ solidity, markdown }) {
  const base = mkdtempSync(join(tmpdir(), "loom-doc-constants-"));
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "docs"), { recursive: true });
  writeFileSync(join(base, "src", "Thing.sol"), solidity);
  writeFileSync(join(base, "docs", "thing.md"), markdown);
  return base;
}

const CONTRACT = `
contract Thing {
    uint256 public constant MAX_HOOKS = 8;
    uint48 public constant MIN_CONFIG_DELAY = 3 days;
    uint48 public constant MIN_VAULT_DELAY = 1 hours;
    uint256 public constant MAX_REVERT_DATA_LENGTH = 2_048;
}
`;

test("matching values pass in both documented shapes", () => {
  const base = fixture({
    solidity: CONTRACT,
    markdown: "`MAX_HOOKS` is 8 and `MIN_CONFIG_DELAY` (3 days) applies.\n",
  });
  assert.deepEqual(validateDocConstants(base), []);
});

test("a stale number is reported with the file, line, and both values", () => {
  const base = fixture({ solidity: CONTRACT, markdown: "The limit `MAX_HOOKS` is 4 today.\n" });
  const problems = validateDocConstants(base);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/thing\.md:1/u);
  assert.match(problems[0], /`MAX_HOOKS` is 8 in src\/Thing\.sol/u);
  assert.match(problems[0], /states 4/u);
});

test("a stale duration is caught even when the unit still matches", () => {
  const base = fixture({ solidity: CONTRACT, markdown: "`MIN_CONFIG_DELAY` (7 days)\n" });
  const problems = validateDocConstants(base);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /3 days/u);
});

test("a duration stated in a different unit is compared, not rejected", () => {
  const base = fixture({ solidity: CONTRACT, markdown: "`MIN_CONFIG_DELAY` (72 hours)\n" });
  assert.deepEqual(validateDocConstants(base), []);
});

test("prose singular units are accepted", () => {
  const base = fixture({ solidity: CONTRACT, markdown: "`MIN_VAULT_DELAY` (1 hour)\n" });
  assert.deepEqual(validateDocConstants(base), []);
});

test("thousands separators are read on both sides", () => {
  const base = fixture({ solidity: CONTRACT, markdown: "`MAX_REVERT_DATA_LENGTH` (2,048 bytes)\n" });
  assert.deepEqual(validateDocConstants(base), []);
});

test("a name the contracts do not declare is left alone", () => {
  const base = fixture({ solidity: CONTRACT, markdown: "`HTTP_TIMEOUT` is 30 seconds\n" });
  assert.deepEqual(validateDocConstants(base), []);
});

test("a constant declared twice with different values is reported rather than guessed", () => {
  const base = fixture({
    solidity: `${CONTRACT}\ncontract Other { uint256 public constant MAX_HOOKS = 16; }\n`,
    markdown: "`MAX_HOOKS` is 8\n",
  });
  const problems = validateDocConstants(base);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /conflicting values/u);
});

test("an alias to another library constant contributes no value of its own", () => {
  const base = fixture({
    solidity: "contract Thing { uint256 public constant MAX_HOOKS = Lib.MAX_HOOKS; }\n",
    markdown: "`MAX_HOOKS` is 8\n",
  });
  // Nothing to compare against, so nothing is claimed. The checker must not
  // invent a value for an alias it cannot resolve.
  assert.deepEqual(validateDocConstants(base), []);
  assert.equal(contractConstants(base).has("MAX_HOOKS"), false);
});
