import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(file, text, message) {
  const normalized = read(file).replace(/\s+/g, " ");
  assert(normalized.includes(text), `${file}: ${message}`);
}

assert(exists("formal/kontrol/README.md"), "formal/kontrol/README.md is required");
assert(exists("formal/kontrol/targets.json"), "formal/kontrol/targets.json is required");
assert(exists("formal/kontrol/version.txt"), "formal/kontrol/version.txt is required");

const version = read("formal/kontrol/version.txt").trim();
assert(/^v\d+\.\d+\.\d+$/u.test(version), "Kontrol version must be a pinned release tag");

const manifest = JSON.parse(read("formal/kontrol/targets.json"));
assert(manifest.version === 1, "formal/kontrol/targets.json must use version 1");
assert(manifest.tool === "kontrol", "formal/kontrol/targets.json must target kontrol");
assert(Array.isArray(manifest.targets) && manifest.targets.length >= 6, "Kontrol target manifest must list initial proof targets");

const names = new Set();
for (const target of manifest.targets) {
  for (const key of ["name", "contract", "matchTest", "property", "source"]) {
    assert(typeof target[key] === "string" && target[key].length > 0, `Kontrol target missing ${key}`);
  }
  assert(!names.has(target.name), `duplicate Kontrol target name: ${target.name}`);
  names.add(target.name);
  assert(target.matchTest.startsWith(target.contract + "."), `${target.name}: matchTest must include the target contract`);
  assert(exists(target.source), `${target.name}: source file does not exist: ${target.source}`);
  assertIncludes(target.source, target.matchTest.split(".")[1], `${target.name}: source file must contain matchTest`);
}

assertIncludes("formal/kontrol/README.md", "kontrol build", "must document Kontrol build command");
assertIncludes("formal/kontrol/README.md", "kontrol prove --match-test", "must document Kontrol prove command");
assertIncludes("formal/kontrol/README.md", "not complete wallet verification", "must state claim boundary");
assertIncludes("formal/kontrol/README.md", "formal/kontrol/version.txt", "must document the pinned Kontrol version source");
assert(names.has("initialization-one-shot"), "Kontrol targets must include initialization one-shot property");
assert(names.has("immutable-proxy-no-upgrade-selector"), "Kontrol targets must include immutable proxy anti-upgrade property");

const workflow = read(".github/workflows/kontrol.yml");
assert(workflow.includes('"$KUP_BIN" install kontrol --version "$(cat formal/kontrol/version.txt)"'), "Kontrol workflow must install the pinned version");
assert(workflow.includes("run-metadata.json"), "Kontrol workflow must record run metadata");
assert(workflow.includes("name: kontrol-prover-${{ github.sha }}"), "Kontrol artifact must bind the commit");
assert(workflow.includes("path: artifacts/kontrol"), "Kontrol workflow must archive prover evidence");
assert(workflow.includes("if: always()"), "Kontrol workflow must archive partial evidence after failure");
assertIncludes("tools/formal/setup-linux-provers.sh", 'kup install kontrol --version "$(cat formal/kontrol/version.txt)"', "local setup must install the pinned version");

console.log("kontrol program structure ok");
