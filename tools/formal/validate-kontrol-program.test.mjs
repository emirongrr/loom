import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("kontrol program validator passes", () => {
  const result = spawnSync(process.execPath, ["tools/formal/validate-kontrol-program.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /kontrol program structure ok/);
});
