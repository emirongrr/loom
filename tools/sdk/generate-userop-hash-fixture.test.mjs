import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./generate-userop-hash-fixture.mjs";

// Keeps the committed fixture honest to @loom/core: if the hashing changes, this
// fails until the fixture is regenerated (and the Solidity differential then
// re-validates it against the real EntryPoint library).
test("committed userop-hash fixture is current", () => {
  const path = fileURLToPath(new URL("../../test/fixtures/userop-hash.json", import.meta.url));
  const committed = readFileSync(path, "utf8");
  const expected = `${JSON.stringify(buildFixture(), null, 2)}\n`;
  assert.equal(committed, expected);
});
