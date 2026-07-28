import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";

// Regression: ajv builds its validators with `new Function`, which a strict
// `script-src` CSP (no `unsafe-eval`) forbids. Compiling at import time would
// make merely importing @loom/core throw in such a context — e.g. a browser
// wallet that enforces `script-src 'self'`. The manifest validator must
// therefore compile lazily, on first use, not at module load.
test("the deployment-manifest validator compiles lazily, not at import time", async () => {
  const original = Ajv.prototype.compile;
  let compiles = 0;
  Ajv.prototype.compile = function (...args) {
    compiles += 1;
    return original.apply(this, args);
  };
  try {
    const mod = await import("../dist/manifest.js");
    assert.equal(compiles, 0, "importing @loom/core must not compile a schema (would need eval under a strict CSP)");
    assert.throws(() => mod.parseDeploymentManifest({}), /invalid deployment manifest/);
    assert.ok(compiles >= 1, "the validator compiles on first use");
  } finally {
    Ajv.prototype.compile = original;
  }
});
