// Publishes the canonical deployment-manifest JSON Schema from its single source
// of truth in @loom/core (DEPLOYMENT_MANIFEST_SCHEMA_V1) to
// schemas/deployment-manifest/v1.schema.json, so external tooling can consume the
// same contract @loom/core validates against.
//
// Run `npm run manifest:schema:generate` after an intentional schema change and
// commit the regenerated file. tools/sdk/generate-manifest-schema.test.mjs keeps
// the committed file honest to the source.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_MANIFEST_SCHEMA_V1 } from "../../packages/core/dist/index.js";

export function buildSchema() {
  return DEPLOYMENT_MANIFEST_SCHEMA_V1;
}

const schemaPath = fileURLToPath(new URL("../../schemas/deployment-manifest/v1.schema.json", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(schemaPath), { recursive: true });
  writeFileSync(schemaPath, `${JSON.stringify(buildSchema(), null, 2)}\n`);
  console.log(`wrote ${schemaPath}`);
}
