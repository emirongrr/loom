import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

const blockedCliDependencies = new Set(["jake", "filelist", "minimatch", "brace-expansion"]);

test("wallet runtime proof imports do not enter the vulnerable EJS CLI dependency path", async () => {
  const originalLoad = Module._load;
  const attempted = [];
  Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedCliDependencies.has(request)) {
      attempted.push(request);
      throw new Error(`wallet runtime loaded CLI-only dependency ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const snarkjs = await import("snarkjs");
    assert.equal(typeof snarkjs.groth16.fullProve, "function");

    const ejs = await import("ejs");
    assert.equal(ejs.default.render("<%= value %>", { value: "wallet input" }), "wallet input");
    assert.deepEqual(attempted, []);
  } finally {
    Module._load = originalLoad;
  }
});
