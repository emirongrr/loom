import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const siteRoot = join(root, "docs", "site");
const requiredFiles = [
  "package.json",
  "package-lock.json",
  "README.md",
  "tsconfig.json",
  "vocs.config.ts",
  "pages/index.mdx",
  "pages/getting-started.mdx",
  "pages/sdk.mdx",
  "pages/comparisons.mdx",
  "pages/security.mdx",
  "public/llms.txt",
  "public/llms-full.txt"
];

for (const file of requiredFiles) {
  const path = join(siteRoot, file);
  if (!existsSync(path)) throw new Error(`missing website file: ${file}`);
}

const config = readFileSync(join(siteRoot, "vocs.config.ts"), "utf8");
assertIncludes(config, "basePath: '/loom'", "docs/site/vocs.config.ts");
assertIncludes(config, "title: 'Loom'", "docs/site/vocs.config.ts");

const index = readFileSync(join(siteRoot, "pages", "index.mdx"), "utf8");
for (const phrase of [
  "Self-sovereign wallet infrastructure",
  "No admin keys",
  "Passkeys",
  "Recovery",
  "Provider consent",
  "pre-audit"
]) {
  assertIncludes(index, phrase, "docs/site/pages/index.mdx");
}

for (const file of ["public/llms.txt", "public/llms-full.txt"]) {
  const content = readFileSync(join(siteRoot, file), "utf8");
  assertIncludes(content, "Loom", `docs/site/${file}`);
}

console.log("validated Vocs website structure");

function assertIncludes(content, needle, file) {
  if (!content.includes(needle)) throw new Error(`${file} must include ${needle}`);
}
