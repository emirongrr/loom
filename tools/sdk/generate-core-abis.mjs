// Generates @loom/core's ABI modules from reviewed Foundry artifacts.
//
// The compiled artifact is the single source of truth: each module under
// packages/core/src/abi/ is emitted verbatim from out/<Contract>.sol/<Contract>.json
// and committed, so the SDK's encoders can never drift from the contracts they
// target. tools/sdk/generate-core-abis.test.mjs re-runs this generator against
// the current artifacts and fails when a committed module is stale.
//
// Run `forge build` then `npm run abi:generate` after an intentional contract
// interface change and commit the regenerated modules.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The curated contract set the SDK consumes. Extend deliberately: every entry
// becomes public API surface of @loom/core.
export const GENERATED_ABIS = Object.freeze([
  Object.freeze({ contract: "LoomAccount", exportName: "LoomAccountAbi", file: "loom-account.ts" }),
  Object.freeze({ contract: "LoomAccountFactory", exportName: "LoomAccountFactoryAbi", file: "loom-account-factory.ts" }),
  Object.freeze({ contract: "P256Validator", exportName: "P256ValidatorAbi", file: "p256-validator.ts" }),
  Object.freeze({ contract: "EntryPoint", exportName: "EntryPointAbi", file: "entry-point.ts" })
]);

export function renderAbiModule({ contract, exportName }, root = repoRoot) {
  const artifactPath = join(root, "out", `${contract}.sol`, `${contract}.json`);
  if (!existsSync(artifactPath)) {
    throw new Error(`missing Foundry artifact for ${contract}: run \`forge build\` first (${artifactPath})`);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    throw new Error(`artifact for ${contract} carries no ABI`);
  }
  return [
    `// Generated from out/${contract}.sol/${contract}.json — do not edit.`,
    "// Regenerate with `forge build && npm run abi:generate`.",
    `export const ${exportName} = ${JSON.stringify(artifact.abi, null, 2)} as const;`,
    ""
  ].join("\n");
}

export function renderIndexModule() {
  return [
    "// Generated — do not edit. Regenerate with `forge build && npm run abi:generate`.",
    ...GENERATED_ABIS.map(entry => `export { ${entry.exportName} } from "./${entry.file.replace(/\.ts$/, ".js")}";`),
    ""
  ].join("\n");
}

const abiDir = join(repoRoot, "packages", "core", "src", "abi");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(abiDir, { recursive: true });
  for (const entry of GENERATED_ABIS) {
    writeFileSync(join(abiDir, entry.file), renderAbiModule(entry));
    console.log(`wrote packages/core/src/abi/${entry.file}`);
  }
  writeFileSync(join(abiDir, "index.ts"), renderIndexModule());
  console.log("wrote packages/core/src/abi/index.ts");
}
