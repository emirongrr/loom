import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateWebAuthnFixtures } from "../validate-webauthn-fixtures.mjs";
import { buildReferenceFixture } from "./generate-reference-fixture.mjs";

export async function runVirtualWebAuthnFixture() {
  const root = await mkdtemp(join(tmpdir(), "loom-webauthn-virtual-"));
  await cp(new URL("../../fixtures/webauthn/matrix.json", import.meta.url), join(root, "matrix.json"));
  await cp(new URL("../../fixtures/webauthn/corpus", import.meta.url), join(root, "corpus"), {
    recursive: true,
    force: true
  });
  await mkdir(join(root, "virtual"), { recursive: true });
  const fixture = buildReferenceFixture({
    evidenceKind: "virtual",
    matrixId: "virtual-node-p256",
    collectorSource: "tools/webauthn-fixture/virtual-runner.mjs",
    captureMode: "virtual-authenticator"
  });
  await writeFile(join(root, "virtual", "node-p256.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  return validateWebAuthnFixtures({ root: pathToFileURL(`${root}/`) });
}

async function main() {
  const result = await runVirtualWebAuthnFixture();
  console.log(
    `validated virtual WebAuthn fixture(s); ${result.fixtureCount} fixture(s), ${result.incompleteCount} real-device combination(s) remain`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
