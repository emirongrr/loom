// Build the publishable Loom packages into installable, checksummed tarballs.
//
//   node tools/release/pack-packages.mjs [version] [outDir]
//
// The publishable surface is @loom/core (the leaf) and @loom/sdk (the wallet
// engine). Each is staged with a real release version, its `file:` sibling
// dependency rewritten to that exact version, and its private/dev-only fields
// stripped, so the tarball is what an external project would install — never the
// in-repo manifest, which stays untouched. The output is a set of `.tgz` files,
// a SHA256SUMS file, and a release-manifest.json binding package to version and
// npm integrity hash.
//
// This is the single packing path: the release workflow packs at the git-tag
// version, and the clean-room example test packs and installs these same
// tarballs, so the artifact that ships is the artifact that is proven.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// fs.rmSync can return success WITHOUT deleting on Windows when the path
// contains non-ASCII segments (observed on Node 23), which would let stale
// tarballs from a previous run leak into the packed output. unlink/rmdir take
// the path verbatim and work, so removal walks the tree explicitly.
export function removeTreeSync(path) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      removeTreeSync(join(path, entry.name));
    }
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

// The publish order matters: core has no Loom dependency; sdk depends on core.
const PUBLISHABLE = [
  { name: "@loom/core", dir: "packages/core", loomDeps: [] },
  { name: "@loom/sdk", dir: "packages/sdk", loomDeps: ["@loom/core"] }
];

function tarballName(name, version) {
  return `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

// Stage a copy of the package with a release-ready manifest and pack it. The
// tracked package.json is never modified; only the staged copy is.
function stageAndPack({ repoRoot, pkg, version, outDir }) {
  const source = join(repoRoot, pkg.dir);
  const stage = join(outDir, "stage", pkg.name.replace("/", "-").replace("@", ""));
  removeTreeSync(stage);
  mkdirSync(stage, { recursive: true });

  const dist = join(source, "dist");
  if (!existsSync(dist)) {
    throw new Error(`${pkg.name} is not built (missing ${dist}); run the package build first`);
  }
  cpSync(dist, join(stage, "dist"), { recursive: true });
  const readme = join(source, "README.md");
  if (existsSync(readme)) cpSync(readme, join(stage, "README.md"));

  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  manifest.version = version;
  delete manifest.private;
  delete manifest.devDependencies;
  delete manifest.scripts;
  for (const dep of pkg.loomDeps) {
    if (!manifest.dependencies?.[dep]) throw new Error(`${pkg.name} is missing expected dependency ${dep}`);
    manifest.dependencies[dep] = version;
  }
  // Publish and stability metadata. The packages are pre-audit; the label is
  // part of the artifact so a consumer can read it, and provenance is declared
  // so a real publish is attested without further configuration.
  manifest.publishConfig = { access: "public", provenance: true };
  manifest.loom = { stability: "experimental", audited: false };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const result = spawnSync(npm, ["pack", "--pack-destination", outDir], { cwd: stage, stdio: "pipe", encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm pack failed for ${pkg.name}: ${result.stderr}`);

  const filename = tarballName(pkg.name, version);
  const path = join(outDir, filename);
  if (!existsSync(path)) throw new Error(`expected tarball not produced: ${path}`);
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { name: pkg.name, version, filename, path, sha256, integrity, bytes: bytes.length, staged: manifest };
}

export function packReleasePackages({ repoRoot, version, outDir }) {
  removeTreeSync(outDir);
  mkdirSync(outDir, { recursive: true });

  const packed = PUBLISHABLE.map(pkg => stageAndPack({ repoRoot, pkg, version, outDir }));
  removeTreeSync(join(outDir, "stage"));

  const sha256Lines = packed.map(p => `${p.sha256}  ${p.filename}`).join("\n");
  writeFileSync(join(outDir, "SHA256SUMS"), `${sha256Lines}\n`);

  const releaseManifest = {
    schemaVersion: 1,
    version,
    generatedAt: new Date().toISOString(),
    packages: packed.map(({ name, filename, sha256, integrity, bytes }) => ({
      name,
      version,
      filename,
      sha256,
      integrity,
      bytes
    }))
  };
  writeFileSync(join(outDir, "release-manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  // The in-memory `staged` manifests are returned for verification but never
  // serialized into the release manifest, which stays a slim integrity record.
  return { ...releaseManifest, staged: packed.map(({ name, staged }) => ({ name, manifest: staged })) };
}

function build(repoRoot) {
  const result = spawnSync(npm, ["run", "sdk:build"], { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error("package build failed");
}

// Direct execution: build then pack.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const version = (process.argv[2] ?? process.env.RELEASE_VERSION ?? "0.0.0").replace(/^v/, "");
  const outDir = process.argv[3] ? join(repoRoot, process.argv[3]) : join(repoRoot, "dist-release");
  build(repoRoot);
  const manifest = packReleasePackages({ repoRoot, version, outDir });
  for (const pkg of manifest.packages) {
    console.log(`packed ${pkg.name}@${pkg.version} -> ${pkg.filename} (${pkg.bytes} bytes, ${pkg.sha256.slice(0, 16)}…)`);
  }
  console.log(`\nrelease manifest and SHA256SUMS written to ${outDir}`);
}

export { PUBLISHABLE, tarballName };
