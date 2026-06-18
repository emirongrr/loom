import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../fixtures/webauthn/", import.meta.url);
const rootPath = fileURLToPath(root);
const matrix = JSON.parse(await readFile(new URL("matrix.json", root), "utf8"));
const requireComplete = process.argv.includes("--require-complete");
const ids = new Set();
const matrixById = new Map();
const p256HalfOrder = 0x7fffffff800000007fffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

if (matrix.version !== 1 || !Array.isArray(matrix.required)) {
  throw new Error("invalid WebAuthn fixture matrix");
}
const requiredNegativeMutations = Object.freeze(matrix.requiredNegativeMutations ?? []);
if (requiredNegativeMutations.length === 0) throw new Error("fixture matrix must define required negative mutations");
for (const item of matrix.required) {
  if (!item.id || ids.has(item.id)) throw new Error(`invalid or duplicate matrix id: ${item.id}`);
  if (!["missing", "captured", "verified"].includes(item.status)) {
    throw new Error(`invalid status for ${item.id}: ${item.status}`);
  }
  if (!item.browser || !item.authenticator) throw new Error(`incomplete matrix item: ${item.id}`);
  ids.add(item.id);
  matrixById.set(item.id, item);
}

const files = (await readdir(root)).filter(name => name.endsWith(".json") && name !== "schema.json" && name !== "matrix.json");
const fixtureIds = new Set();
for (const name of files) {
  const fixture = JSON.parse(await readFile(join(rootPath, name), "utf8"));
  if (!matrixById.has(fixture.matrixId)) throw new Error(`${name}: fixture matrixId is not required: ${fixture.matrixId}`);
  if (fixtureIds.has(fixture.matrixId)) throw new Error(`${name}: duplicate fixture matrixId: ${fixture.matrixId}`);
  fixtureIds.add(fixture.matrixId);

  for (const key of ["publicKeyX", "publicKeyY", "credentialIdHash", "challenge", "r", "s"]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fixture[key] ?? "")) throw new Error(`${name}: invalid ${key}`);
  }
  if (fixture.version !== 1 || fixture.expected !== true) throw new Error(`${name}: invalid fixture metadata`);
  if (!fixture.rpId || !fixture.origin || !fixture.authenticatorData || !fixture.clientDataJSON) {
    throw new Error(`${name}: incomplete assertion`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fixture.capturedAt ?? "")) throw new Error(`${name}: invalid capturedAt`);

  const matrixItem = matrixById.get(fixture.matrixId);
  if (fixture.browser !== matrixItem.browser) throw new Error(`${name}: browser does not match matrix item`);
  if (fixture.authenticator !== matrixItem.authenticator) {
    throw new Error(`${name}: authenticator does not match matrix item`);
  }

  const missingMutations = requiredNegativeMutations.filter(item => !fixture.negativeMutations?.includes(item));
  if (matrixItem.status === "verified" && missingMutations.length !== 0) {
    throw new Error(`${name}: missing negative mutation evidence: ${missingMutations.join(", ")}`);
  }

  const clientData = JSON.parse(fixture.clientDataJSON);
  if (clientData.type !== "webauthn.get") throw new Error(`${name}: unexpected clientData type`);
  if (clientData.origin !== fixture.origin) throw new Error(`${name}: clientData origin mismatch`);
  if (bytesToHex(base64UrlDecode(clientData.challenge)) !== fixture.challenge.toLowerCase()) {
    throw new Error(`${name}: clientData challenge mismatch`);
  }

  const authenticatorData = hexToBytes(fixture.authenticatorData);
  if (authenticatorData.length < 37) throw new Error(`${name}: authenticatorData too short`);
  const rpIdHash = bytesToHex(createHash("sha256").update(fixture.rpId).digest());
  if (bytesToHex(authenticatorData.slice(0, 32)) !== rpIdHash) throw new Error(`${name}: rpId hash mismatch`);
  const flags = authenticatorData[32];
  if ((flags & 0x01) === 0) throw new Error(`${name}: user presence flag missing`);
  if ((flags & 0x04) === 0) throw new Error(`${name}: user verification flag missing`);
  if (BigInt(fixture.s) > p256HalfOrder) throw new Error(`${name}: signature s is not low-s`);
}

for (const item of matrix.required) {
  if (["captured", "verified"].includes(item.status) && !fixtureIds.has(item.id)) {
    throw new Error(`matrix marks ${item.id} as ${item.status} but no fixture exists`);
  }
}

const incomplete = matrix.required.filter(item => item.status !== "verified");
if (requireComplete && incomplete.length !== 0) {
  throw new Error(`unverified WebAuthn matrix: ${incomplete.map(item => item.id).join(", ")}`);
}
console.log(`validated ${files.length} fixture(s); ${incomplete.length} required combination(s) remain`);

function hexToBytes(value) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("invalid byte hex");
  return Buffer.from(value.slice(2), "hex");
}

function bytesToHex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}
