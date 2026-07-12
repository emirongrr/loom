import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./generate-account-derivation-fixture.mjs";

// Keeps the committed fixture honest to @loom/core: if the derivation or the
// calldata encoding changes, this fails until the fixture is regenerated (and
// the Solidity differential then re-validates it against the contracts).
test("committed account-derivation fixture is current", () => {
  const path = fileURLToPath(new URL("../../test/fixtures/account-derivation.json", import.meta.url));
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(buildFixture(), null, 2)}\n`);
});
