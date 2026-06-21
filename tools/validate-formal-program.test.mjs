import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("formal program validator passes", () => {
  const result = spawnSync(process.execPath, ["tools/validate-formal-program.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /formal program structure ok/);
});
