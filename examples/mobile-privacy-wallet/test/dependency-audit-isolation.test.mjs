import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const executableExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const forbiddenRuntimeImport = /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:image-size|metro(?:\/[^"']*)?|@expo\/metro(?:-config)?(?:\/[^"']*)?)["']/;

test("wallet runtime input cannot reach Metro's vulnerable image parsers", () => {
  const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const imageSizeParents = Object.entries(lockfile.packages)
    .filter(([, entry]) => entry.dependencies?.["image-size"] || entry.optionalDependencies?.["image-size"])
    .map(([path]) => path)
    .sort();

  assert.deepEqual(imageSizeParents, ["node_modules/metro"]);

  const runtimeRoots = ["App.tsx", "index.ts", "src", "modules"]
    .map(path => join(root, path))
    .filter(existsSync);
  const violations = runtimeRoots.flatMap(scanRuntimeImports);

  assert.deepEqual(violations, []);
});

function scanRuntimeImports(path) {
  if (statSync(path).isFile()) {
    return executableExtensions.has(extname(path)) && forbiddenRuntimeImport.test(readFileSync(path, "utf8"))
      ? [path]
      : [];
  }
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap(entry => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return scanRuntimeImports(child);
    if (!entry.isFile() || !executableExtensions.has(extname(child))) return [];
    return forbiddenRuntimeImport.test(readFileSync(child, "utf8")) ? [child] : [];
  });
}
