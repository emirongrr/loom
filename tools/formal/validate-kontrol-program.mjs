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
assert(exists("formal/kontrol/toolchain.pin"), "formal/kontrol/toolchain.pin is required");

const pin = read("formal/kontrol/toolchain.pin").trim();
assert(/^v\d+\.\d+\.\d+@[0-9a-f]{40}$/u.test(pin), "Kontrol pin must bind a release tag to an immutable commit revision");

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
assertIncludes("formal/kontrol/README.md", "formal/kontrol/toolchain.pin", "must document the pinned Kontrol toolchain source");
assert(names.has("initialization-one-shot"), "Kontrol targets must include initialization one-shot property");
assert(names.has("immutable-proxy-no-upgrade-selector"), "Kontrol targets must include immutable proxy anti-upgrade property");

const workflow = read(".github/workflows/kontrol.yml");
assert(
  workflow.includes("sudo rm -rf /usr/local/lib/android /usr/share/dotnet"),
  "Kontrol workflow must reclaim unused hosted-runner disk before installing the prover",
);
assert(
  workflow.includes(
    "runtimeverificationinc/kontrol:ubuntu-jammy-1.0.255@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204",
  ),
  "Kontrol workflow must pin the official release image to an immutable digest",
);
assert(
  workflow.includes('echo "revision=$KONTROL_REVISION" >> "$GITHUB_OUTPUT"'),
  "Kontrol workflow must expose the immutable tool revision",
);
assert(workflow.includes('docker pull "$KONTROL_IMAGE"'), "Kontrol workflow must pull the pinned prover image");
assert(workflow.includes("docker run --rm --network none"), "Kontrol prover containers must run without network access");
assert(workflow.includes("artifacts/kontrol/memory-before.txt"), "Kontrol workflow must record initial memory state");
assert(workflow.includes("artifacts/kontrol/memory-after.txt"), "Kontrol workflow must record final memory state");
assert(
  workflow.includes("kontrol build --verbose --no-llvm-kompile"),
  "Kontrol proof build must archive verbose output and skip the unused LLVM runtime",
);
assert(
  workflow.includes("solc-linux-amd64-v0.8.35+commit.47b9dedd") &&
    workflow.includes("fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4"),
  "Kontrol workflow must pin the Solidity compiler binary and checksum",
);
assert(workflow.includes("sha256sum --check -"), "Kontrol workflow must verify the Solidity compiler checksum");
assert(workflow.includes("FOUNDRY_SOLC=/opt/loom-solc/solc"), "Kontrol must use the mounted compiler binary");
assert(workflow.includes('-v "$RUNNER_TEMP/solc:/opt/loom-solc:ro"'), "Kontrol must mount the compiler read-only");
assert(
  workflow.includes('rsync -a --delete') &&
    workflow.includes('--exclude .git --exclude artifacts --exclude out --exclude cache'),
  "Kontrol must copy tracked project inputs into an isolated prover workspace",
);
assert(
  workflow.includes('-v "$RUNNER_TEMP/kontrol-workspace:/workspace"'),
  "Kontrol must mount the isolated prover workspace as writable",
);
assert(
  workflow.includes('sudo chown -R 1010:1010 "$RUNNER_TEMP/kontrol-workspace"'),
  "Kontrol isolated workspace must belong to the immutable image user",
);
assert(workflow.includes("artifacts/kontrol/image-pull.log"), "Kontrol workflow must archive image pull output");
assert(workflow.includes("artifacts/kontrol/image-inspect.json"), "Kontrol workflow must archive image identity");
assert(workflow.includes("kontrolRelease"), "Kontrol evidence must record the readable release tag");
assert(workflow.includes("kontrolRevision"), "Kontrol evidence must record the immutable revision");
assert(workflow.includes("kontrolImage"), "Kontrol evidence must record the immutable prover image");
assert(workflow.includes("run-metadata.json"), "Kontrol workflow must record run metadata");
assert(workflow.includes("name: kontrol-prover-${{ github.sha }}"), "Kontrol artifact must bind the commit");
assert(workflow.includes("path: artifacts/kontrol"), "Kontrol workflow must archive prover evidence");
assert(workflow.includes("if: always()"), "Kontrol workflow must archive partial evidence after failure");
assertIncludes("tools/formal/setup-linux-provers.sh", 'kup install kontrol --version "${KONTROL_PIN#*@}"', "local setup must install the immutable revision");

console.log("kontrol program structure ok");
