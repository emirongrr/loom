import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("certora program validator passes", () => {
  const result = spawnSync(process.execPath, ["tools/formal/validate-certora-program.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /certora program structure ok/);
});
