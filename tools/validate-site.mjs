import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const siteRoot = join(root, "website");
const requiredFiles = [
  "index.html",
  "getting-started.html",
  "sdk.html",
  "comparisons.html",
  "security.html",
  "llms.txt",
  "llms-full.txt",
  "assets/styles.css"
];

for (const file of requiredFiles) {
  const path = join(siteRoot, file);
  if (!existsSync(path)) throw new Error(`missing website file: ${file}`);
}

const htmlFiles = walk(siteRoot).filter(path => extname(path) === ".html");
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  assertIncludes(html, "<!doctype html>", file);
  assertIncludes(html, "<meta name=\"viewport\"", file);
  assertIncludes(html, "Loom", file);
  for (const href of [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1])) {
    if (href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("#")) continue;
    const [target] = href.split("#");
    if (target === "") continue;
    const resolved = join(siteRoot, target);
    if (!existsSync(resolved)) throw new Error(`broken website link in ${file}: ${href}`);
  }
}

const index = readFileSync(join(siteRoot, "index.html"), "utf8");
for (const phrase of [
  "Self-sovereign wallet infrastructure",
  "No admin keys",
  "Passkeys",
  "Recovery",
  "Kohaku",
  "pre-audit"
]) {
  assertIncludes(index, phrase, "website/index.html");
}

console.log(`validated ${htmlFiles.length} website page(s)`);

function walk(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function assertIncludes(content, needle, file) {
  if (!content.includes(needle)) throw new Error(`${file} must include ${needle}`);
}
