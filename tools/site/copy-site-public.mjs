import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const siteRoot = join(root, "docs", "site");
const publicRoot = join(siteRoot, "public");
const distRoot = join(siteRoot, "dist");
const files = ["llms.txt", "llms-full.txt"];

if (!existsSync(distRoot)) {
  throw new Error("docs/site/dist does not exist; run the docs build first");
}

mkdirSync(distRoot, { recursive: true });

for (const file of files) {
  const source = join(publicRoot, file);
  const target = join(distRoot, file);
  if (!existsSync(source)) throw new Error(`missing docs public file: ${file}`);
  copyFileSync(source, target);
}

console.log("copied docs public files");
