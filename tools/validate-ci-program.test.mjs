import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("ci program validator passes", () => {
  const result = spawnSync(process.execPath, ["tools/validate-ci-program.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ci program structure ok/);
});
