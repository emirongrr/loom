import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validateKohakuStack();
  console.log("validated Kohaku stack dependency evidence");
}

export async function validateKohakuStack(options = {}) {
  const repoRoot = options.root ?? root;
  const privacyPackage = await readJson(join(repoRoot, "packages", "privacy", "package.json"));
  const manifestPath = join(repoRoot, "packages", "privacy", "kohaku-stack.json");
  const manifest = await readJson(manifestPath);

  if (manifest.upstream !== "https://github.com/ethereum/kohaku") {
    throw new Error("kohaku stack upstream must be the Ethereum Kohaku repository");
  }
  if (!manifest.revision || typeof manifest.revision !== "string") {
    throw new Error("kohaku stack revision is required");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("kohaku stack packages must be non-empty");
  }

  const dependencies = privacyPackage.dependencies ?? {};
  const seen = new Set();
  for (const item of manifest.packages) {
    validatePackageItem(item, dependencies);
    if (seen.has(item.name)) throw new Error(`duplicate Kohaku stack item: ${item.name}`);
    seen.add(item.name);
  }

  for (const [name, version] of Object.entries(dependencies)) {
    if (name.startsWith("@kohaku-eth/") && !manifest.packages.some(item => item.name === name && item.version === version)) {
      throw new Error(`missing Kohaku dependency in stack manifest: ${name}@${version}`);
    }
  }

  const overrides = privacyPackage.overrides ?? {};
  assertOverride(overrides, "ws", "8.21.0");
  assertOverride(overrides, "underscore", "1.13.8");
  for (const key of Object.keys(overrides)) {
    if (!["ws", "underscore"].includes(key)) throw new Error(`unreviewed Kohaku override: ${key}`);
  }
}

function validatePackageItem(item, dependencies) {
  if (!item || typeof item !== "object") throw new Error("kohaku stack item must be an object");
  if (!item.name || typeof item.name !== "string") throw new Error("kohaku stack item name is required");
  if (!item.kind || typeof item.kind !== "string") throw new Error(`${item.name}.kind is required`);
  if (!item.version || typeof item.version !== "string") throw new Error(`${item.name}.version is required`);
  if (item.required !== true && item.required !== false) throw new Error(`${item.name}.required must be boolean`);
  if (!item.loomSurface || typeof item.loomSurface !== "string") throw new Error(`${item.name}.loomSurface is required`);

  if (item.kind === "npm") {
    if (dependencies[item.name] !== item.version) {
      throw new Error(`${item.name} manifest version does not match package dependency`);
    }
  }
  if (item.version.includes("alpha") || item.kind !== "npm" || item.name.includes("tornado")) {
    if (!item.productionGate || typeof item.productionGate !== "string") {
      throw new Error(`${item.name} requires a productionGate`);
    }
  }
}

function assertOverride(overrides, name, version) {
  if (overrides[name] !== version) throw new Error(`expected Kohaku override ${name}@${version}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
