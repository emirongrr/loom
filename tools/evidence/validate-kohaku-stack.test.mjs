import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateKohakuStack } from "./validate-kohaku-stack.mjs";

test("Kohaku stack evidence accepts matching dependencies overrides and gates", async () => {
  const root = await fixtureRoot();

  await validateKohakuStack({ root });
});

test("Kohaku stack evidence rejects dependency version drift", async () => {
  const root = await fixtureRoot({
    packagePatch: pkg => {
      pkg.dependencies["@kohaku-eth/railgun"] = "0.0.1-alpha.999";
    }
  });

  await assert.rejects(() => validateKohakuStack({ root }), /manifest version does not match package dependency/);
});

test("Kohaku stack evidence rejects missing production gates for alpha packages", async () => {
  const root = await fixtureRoot({
    manifestPatch: manifest => {
      delete manifest.packages[0].productionGate;
    }
  });

  await assert.rejects(() => validateKohakuStack({ root }), /requires a productionGate/);
});

test("Kohaku stack evidence rejects unreviewed overrides", async () => {
  const root = await fixtureRoot({
    packagePatch: pkg => {
      pkg.overrides.leftpad = "1.0.0";
    }
  });

  await assert.rejects(() => validateKohakuStack({ root }), /unreviewed Kohaku override/);
});

async function fixtureRoot({ packagePatch, manifestPatch } = {}) {
  const root = await mkdtemp(join(tmpdir(), "loom-kohaku-stack-"));
  const privacyDir = join(root, "packages", "privacy");
  await mkdir(privacyDir, { recursive: true });
  const pkg = {
    dependencies: {
      "@kohaku-eth/plugins": "0.0.1-alpha.9",
      "@kohaku-eth/railgun": "0.0.1-alpha.26"
    },
    overrides: {
      underscore: "1.13.8",
      ws: "8.21.0"
    }
  };
  const manifest = {
    upstream: "https://github.com/ethereum/kohaku",
    revision: "master",
    packages: [
      {
        name: "@kohaku-eth/plugins",
        kind: "npm",
        version: "0.0.1-alpha.9",
        required: true,
        loomSurface: "Plugin interface",
        productionGate: "Review alpha package before production."
      },
      {
        name: "@kohaku-eth/railgun",
        kind: "npm",
        version: "0.0.1-alpha.26",
        required: true,
        loomSurface: "Shielded backend",
        productionGate: "Review protocol assumptions before production."
      },
      {
        name: "packages/pq-account",
        kind: "kohaku-source",
        version: "master",
        required: true,
        loomSurface: "Hybrid account migration target",
        productionGate: "Audit before importing verifier contracts."
      }
    ]
  };
  packagePatch?.(pkg);
  manifestPatch?.(manifest);
  await writeFile(join(privacyDir, "package.json"), JSON.stringify(pkg, null, 2));
  await writeFile(join(privacyDir, "kohaku-stack.json"), JSON.stringify(manifest, null, 2));
  return root;
}
