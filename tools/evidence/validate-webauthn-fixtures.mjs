import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = new URL("../../fixtures/webauthn/", import.meta.url);
const p256HalfOrder = 0x7fffffff800000007fffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const forbiddenMetadataKeys = new Set([
  "attestationObject",
  "credentialId",
  "displayName",
  "rawId",
  "userAgent",
  "userHandle",
  "username"
]);

export async function validateWebAuthnFixtures({ root = defaultRoot, requireComplete = false } = {}) {
  const rootUrl = root instanceof URL ? root : pathToFileURL(`${root}/`);
  const rootPath = fileURLToPath(rootUrl);
  const matrix = JSON.parse(await readFile(new URL("matrix.json", rootUrl), "utf8"));
  const ids = new Set();
  const matrixById = new Map();

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
    if (!item.browser || !item.platform || !item.authenticator || !item.authenticatorClass) {
      throw new Error(`incomplete matrix item: ${item.id}`);
    }
    if (!Array.isArray(item.transports) || item.transports.length === 0) {
      throw new Error(`matrix item must define transports: ${item.id}`);
    }
    ids.add(item.id);
    matrixById.set(item.id, item);
  }

  const files = (await fixtureFiles(rootPath)).filter(name => name.endsWith(".json"));
  const fixtureIds = new Set();
  for (const name of files) {
    const fixture = JSON.parse(await readFile(join(rootPath, name), "utf8"));
    const evidenceKind = fixture.evidenceKind ?? "corpus";
    rejectForbiddenMetadata(name, fixture);
    if (!["corpus", "reference"].includes(evidenceKind)) {
      throw new Error(`${name}: invalid evidenceKind: ${evidenceKind}`);
    }
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
    if (!/^0x[0-9a-fA-F]{64}$/.test(fixture.userAgentHash ?? "")) {
      throw new Error(`${name}: invalid userAgentHash`);
    }
    if (!fixture.browserVersion || !fixture.platformVersion) {
      throw new Error(`${name}: incomplete environment metadata`);
    }
    if (!Array.isArray(fixture.transports) || fixture.transports.length === 0) {
      throw new Error(`${name}: missing authenticator transports`);
    }
    if (fixture.privacy?.containsRawUserAgent !== false || fixture.privacy?.containsUserIdentifiers !== false) {
      throw new Error(`${name}: fixture must explicitly exclude user identifiers and raw user-agent metadata`);
    }
    if (fixture.privacy?.containsAttestationObject !== false) {
      throw new Error(`${name}: fixture must not include attestation object metadata`);
    }
    assertProvenance(name, evidenceKind, fixture.provenance);

    const matrixItem = matrixById.get(fixture.matrixId);
    if (evidenceKind === "corpus") {
      if (!matrixItem) throw new Error(`${name}: fixture matrixId is not required: ${fixture.matrixId}`);
      if (fixture.browser !== matrixItem.browser) throw new Error(`${name}: browser does not match matrix item`);
      if (fixture.platform !== matrixItem.platform) throw new Error(`${name}: platform does not match matrix item`);
      if (fixture.authenticator !== matrixItem.authenticator) {
        throw new Error(`${name}: authenticator does not match matrix item`);
      }
      if (fixture.authenticatorClass !== matrixItem.authenticatorClass) {
        throw new Error(`${name}: authenticator class does not match matrix item`);
      }
      const missingTransports = matrixItem.transports.filter(item => !fixture.transports.includes(item));
      if (missingTransports.length !== 0) {
        throw new Error(`${name}: missing matrix transport evidence: ${missingTransports.join(", ")}`);
      }
    }

    const missingMutations = requiredNegativeMutations.filter(item => !fixture.negativeMutations?.includes(item));
    if ((evidenceKind !== "corpus" || matrixItem?.status === "verified") && missingMutations.length !== 0) {
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

  return { fixtureCount: files.length, incompleteCount: incomplete.length };
}

async function fixtureFiles(rootPath) {
  const names = await readdir(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of names) {
    if (
      entry.isFile()
        && entry.name !== "schema.json"
        && entry.name !== "negative-case-manifest.schema.json"
        && entry.name !== "matrix.json"
    ) {
      files.push(entry.name);
    }
  }
  for (const directory of ["reference", "corpus"]) {
    const path = join(rootPath, directory);
    try {
      for (const name of await walkJsonFiles(path)) {
        files.push(relative(rootPath, name));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return files;
}

async function walkJsonFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(child);
    }
  }
  return files;
}

function rejectForbiddenMetadata(name, value, path = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (forbiddenMetadataKeys.has(key)) throw new Error(`${name}: forbidden fixture metadata: ${currentPath}`);
    rejectForbiddenMetadata(name, child, currentPath);
  }
}

function assertProvenance(name, evidenceKind, provenance) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error(`${name}: provenance must be an object`);
  }
  const expectedCaptureMode = evidenceKind === "corpus"
    ? "local-secure-context"
    : "reference-vector";
  if (provenance.captureMode !== expectedCaptureMode) {
    throw new Error(`${name}: provenance.captureMode must be ${expectedCaptureMode}`);
  }
  const validCaptureSource = evidenceKind === "corpus"
    ? "browser-device"
    : "reference-vector";
  if (provenance.captureSource !== validCaptureSource) {
    throw new Error(`${name}: provenance.captureSource is invalid`);
  }
  if (provenance.requiresFreshCredential !== true) {
    throw new Error(`${name}: provenance.requiresFreshCredential must be true`);
  }
  if (provenance.reviewedForPII !== true) {
    throw new Error(`${name}: provenance.reviewedForPII must be true`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(provenance.captureSourceHash ?? "")) {
    throw new Error(`${name}: provenance.captureSourceHash must be bytes32`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(provenance.negativeCaseManifestHash ?? "")) {
    throw new Error(`${name}: provenance.negativeCaseManifestHash must be bytes32`);
  }
}

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

async function main() {
  const requireComplete = process.argv.includes("--require-complete");
  const result = await validateWebAuthnFixtures({ requireComplete });
  console.log(`validated ${result.fixtureCount} fixture(s); ${result.incompleteCount} required combination(s) remain`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
