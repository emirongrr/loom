import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateTestDoubles } from "./validate-test-doubles.mjs";

/// Builds a throwaway tree with the given doubles on disk and the given rows in
/// the document, so each test breaks exactly one half of the mapping.
function fixture({ doubles = ["MockThing"], rows = ["| `MockThing` | stands for a thing |"], document = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "loom-test-doubles-"));
  mkdirSync(join(base, "test", "mocks"), { recursive: true });
  mkdirSync(join(base, "docs", "security"), { recursive: true });
  for (const name of doubles) {
    writeFileSync(join(base, "test", "mocks", `${name}.sol`), `contract ${name} {}\n`);
  }
  if (document) {
    writeFileSync(
      join(base, "docs", "security", "test-doubles.md"),
      `# Test Doubles\n\n| Double | Notes |\n| --- | --- |\n${rows.join("\n")}\n`
    );
  }
  return base;
}

test("a complete mapping passes", () => {
  assert.deepEqual(validateTestDoubles(fixture()), []);
});

test("a double with no row fails", () => {
  const problems = validateTestDoubles(fixture({ doubles: ["MockThing", "MockUndocumented"] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /MockUndocumented\.sol has no row/u);
});

test("a row for a deleted double fails", () => {
  const problems = validateTestDoubles(
    fixture({ rows: ["| `MockThing` | ok |", "| `MockDeleted` | stale row |"] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /documents "MockDeleted"/u);
});

test("rows may point at real implementations outside test/mocks", () => {
  const rows = [
    "| `MockThing` | real proof lives in `P256Validator` and `WebAuthnP256` |"
  ];
  assert.deepEqual(validateTestDoubles(fixture({ rows })), []);
});

test("a name mentioned only in prose does not count as documented", () => {
  const base = fixture({ doubles: ["MockThing", "MockProseOnly"] });
  writeFileSync(
    join(base, "docs", "security", "test-doubles.md"),
    "# Test Doubles\n\nWe also have `MockProseOnly` somewhere.\n\n| Double | Notes |\n| --- | --- |\n| `MockThing` | ok |\n"
  );
  const problems = validateTestDoubles(base);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /MockProseOnly\.sol has no row/u);
});

test("a missing document fails rather than passing vacuously", () => {
  const problems = validateTestDoubles(fixture({ document: false }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is missing/u);
});

test("an empty doubles directory fails rather than passing vacuously", () => {
  const problems = validateTestDoubles(fixture({ doubles: [], rows: [] }));
  assert.ok(problems.some(problem => /contains no doubles/u.test(problem)));
});
