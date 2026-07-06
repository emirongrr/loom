import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFixture, encodeCase } from "../../../tools/generate-sdk-calldata-fixture.mjs";

// SDK side of the calldata differential. The committed fixture
// (test/fixtures/sdk-calldata.json) holds calldata the @loom/account encoder
// produced; test/SdkCalldataDifferential.t.sol proves that same calldata equals
// Solidity abi.encodeCall. These tests guard the SDK end: the committed fixture
// must still match the current encoder, so an accidental encoder change (a
// wrong hardcoded selector, broken offset math) is caught here instead of
// silently shipping calldata the contract cannot decode.

const fixturePath = fileURLToPath(new URL("../../../test/fixtures/sdk-calldata.json", import.meta.url));
const committed = JSON.parse(readFileSync(fixturePath, "utf8"));

test("committed calldata fixture matches the current encoder", () => {
  const regenerated = buildFixture();
  assert.deepEqual(
    regenerated,
    committed,
    "test/fixtures/sdk-calldata.json is stale — run `npm run sdk:calldata:generate` and commit"
  );
});

test("every committed case re-encodes to its stored calldata", () => {
  for (const [name, entry] of Object.entries(committed.cases)) {
    assert.equal(encodeCase(entry), entry.calldata, `${name} re-encoded to different calldata`);
  }
});

test("fixture covers the full account lifecycle encoder surface", () => {
  const covered = new Set(Object.values(committed.cases).filter(c => c.group === "account").map(c => c.fn));
  for (const fn of [
    "scheduleCall",
    "executeScheduled",
    "cancelScheduled",
    "scheduleMigration",
    "cancelMigration",
    "revokeTokenAllowance"
  ]) {
    assert.ok(covered.has(fn), `account.${fn} is not covered by the differential fixture`);
  }
});
