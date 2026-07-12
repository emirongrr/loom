import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSchema } from "./generate-manifest-schema.mjs";

// Keeps the published schema honest to @loom/core: if the schema source changes,
// this fails until schemas/deployment-manifest/v1.schema.json is regenerated.
test("committed deployment-manifest schema is current", () => {
  const path = fileURLToPath(new URL("../../schemas/deployment-manifest/v1.schema.json", import.meta.url));
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(buildSchema(), null, 2)}\n`);
});
