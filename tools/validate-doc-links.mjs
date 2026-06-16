import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const topLevel = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
const ignoredDirectories = new Set(["node_modules", "dist"]);

function markdownFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return ignoredDirectories.has(name) ? [] : markdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

function localReferences(file) {
  const text = readFileSync(file, "utf8");
  const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
  const paths = [...text.matchAll(/`((?:docs\/)[^`\s]+\.md)`/g)].map(match => match[1]);
  return [...links, ...paths]
    .map(reference => reference.split("#", 1)[0])
    .filter(reference => reference && !reference.includes("://") && !reference.startsWith("mailto:"));
}

const files = [...topLevel.map(name => join(root, name)), ...markdownFiles(join(root, "docs"))];
const missing = files.flatMap(file =>
  localReferences(file)
    .map(reference => reference.startsWith("docs/") ? resolve(root, reference) : resolve(dirname(file), reference))
    .filter(reference => !existsSync(reference))
    .map(reference => `${file}: ${reference}`)
);

if (missing.length !== 0) {
  throw new Error(`broken documentation references:\n${missing.join("\n")}`);
}

console.log(`validated documentation references across ${files.length} file(s)`);
