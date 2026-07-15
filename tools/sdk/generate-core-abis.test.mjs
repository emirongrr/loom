import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GENERATED_ABIS, renderAbiModule, renderIndexModule } from "./generate-core-abis.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const abiDir = join(repoRoot, "packages", "core", "src", "abi");

// Keeps the committed ABI modules honest to the compiled contracts: if a
// contract interface changes, this fails until `npm run abi:generate` re-emits
// the modules from the fresh artifacts. Requires `forge build` output.
test("committed @loom/core ABI modules match the Foundry artifacts", () => {
  for (const entry of GENERATED_ABIS) {
    const committed = readFileSync(join(abiDir, entry.file), "utf8");
    assert.equal(committed, renderAbiModule(entry), `${entry.file} is stale — run abi:generate`);
  }
  assert.equal(readFileSync(join(abiDir, "index.ts"), "utf8"), renderIndexModule());
});
