import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packReleasePackages, PUBLISHABLE, removeTreeSync } from "./pack-packages.mjs";

// The release packer is the single source of the published artifacts, so its
// invariants are pinned here without needing a live devnet: it assumes the
// packages are already built (the release workflow and clean-room test build
// first) and asserts the staged manifests are release-ready and the tarballs
// are well-formed and self-describing.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const VERSION = "9.9.9-test";

function build() {
  const passkey = spawnSync(npm, ["run", "passkey:build"], { cwd: repoRoot, stdio: "pipe", shell: process.platform === "win32" });
  if (passkey.status !== 0) throw new Error("passkey:build failed in test setup");
  const result = spawnSync(npm, ["run", "sdk:build"], {
    cwd: repoRoot,
    stdio: "ignore",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) throw new Error("sdk:build failed in test setup");
}

function staged(result, name) {
  const entry = result.staged.find(s => s.name === name);
  assert.ok(entry, `${name} was staged`);
  return entry.manifest;
}

test("stages each publishable package with a release-ready manifest", () => {
  build();
  const outDir = mkdtempSync(join(tmpdir(), "loom-release-"));
  try {
    const result = packReleasePackages({ repoRoot, version: VERSION, outDir });
    assert.equal(result.version, VERSION);
    assert.equal(result.packages.length, PUBLISHABLE.length);

    for (const pkg of PUBLISHABLE) {
      const manifest = staged(result, pkg.name);
      assert.equal(manifest.name, pkg.name);
      assert.equal(manifest.version, VERSION, `${pkg.name} version stamped`);
      assert.equal(manifest.private, undefined, `${pkg.name} private flag stripped`);
      assert.equal(manifest.scripts, undefined, `${pkg.name} scripts stripped`);
      assert.equal(manifest.devDependencies, undefined, `${pkg.name} devDependencies stripped`);
      assert.deepEqual(manifest.files, ["dist"], `${pkg.name} ships only dist`);
      assert.equal(manifest.loom.stability, "experimental");
      assert.equal(manifest.loom.audited, false);
      assert.equal(manifest.publishConfig.provenance, true);
      assert.equal(manifest.publishConfig.access, "public");
      // Every Loom dependency is pinned to this exact release version, so the
      // tarballs form a self-consistent install with no floating range.
      for (const dep of pkg.loomDeps) {
        assert.equal(manifest.dependencies[dep], VERSION, `${pkg.name} pins ${dep} to the release version`);
      }
    }
  } finally {
    removeTreeSync(outDir);
  }
});

test("emits valid gzip tarballs plus SHA256SUMS and a release manifest that match the bytes", () => {
  build();
  const outDir = mkdtempSync(join(tmpdir(), "loom-release-"));
  try {
    const result = packReleasePackages({ repoRoot, version: VERSION, outDir });

    const sums = readFileSync(join(outDir, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.equal(sums.length, result.packages.length);

    const onDisk = JSON.parse(readFileSync(join(outDir, "release-manifest.json"), "utf8"));
    assert.equal(onDisk.staged, undefined, "the persisted manifest stays a slim integrity record");

    for (const pkg of result.packages) {
      const bytes = readFileSync(join(outDir, pkg.filename));
      // gzip magic bytes: a truncated or corrupt pack would fail here.
      assert.equal(bytes[0], 0x1f, `${pkg.name} is gzip`);
      assert.equal(bytes[1], 0x8b, `${pkg.name} is gzip`);

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, pkg.sha256, `${pkg.name} recorded sha256 matches bytes`);
      assert.equal(bytes.length, pkg.bytes, `${pkg.name} recorded size matches bytes`);
      assert.ok(sums.includes(`${pkg.sha256}  ${pkg.filename}`), `${pkg.name} appears in SHA256SUMS`);
      assert.ok(pkg.integrity.startsWith("sha512-"), `${pkg.name} carries an npm integrity hash`);
      assert.equal(existsSync(join(outDir, pkg.filename)), true);
    }
  } finally {
    removeTreeSync(outDir);
  }
});
