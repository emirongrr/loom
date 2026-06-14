import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../fixtures/webauthn/", import.meta.url);
const matrix = JSON.parse(await readFile(new URL("matrix.json", root), "utf8"));
const requireComplete = process.argv.includes("--require-complete");
const ids = new Set();

for (const item of matrix.required) {
  if (!item.id || ids.has(item.id)) throw new Error(`invalid or duplicate matrix id: ${item.id}`);
  if (!["missing", "captured", "verified"].includes(item.status)) {
    throw new Error(`invalid status for ${item.id}: ${item.status}`);
  }
  ids.add(item.id);
}

const files = (await readdir(root)).filter(name => name.endsWith(".json") && name !== "schema.json" && name !== "matrix.json");
for (const name of files) {
  const fixture = JSON.parse(await readFile(join(root.pathname, name), "utf8"));
  for (const key of ["publicKeyX", "publicKeyY", "credentialIdHash", "challenge", "r", "s"]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fixture[key] ?? "")) throw new Error(`${name}: invalid ${key}`);
  }
  if (fixture.version !== 1 || fixture.expected !== true) throw new Error(`${name}: invalid fixture metadata`);
  if (!fixture.rpId || !fixture.origin || !fixture.authenticatorData || !fixture.clientDataJSON) {
    throw new Error(`${name}: incomplete assertion`);
  }
}

const incomplete = matrix.required.filter(item => item.status !== "verified");
if (requireComplete && incomplete.length !== 0) {
  throw new Error(`unverified WebAuthn matrix: ${incomplete.map(item => item.id).join(", ")}`);
}
console.log(`validated ${files.length} fixture(s); ${incomplete.length} required combination(s) remain`);
