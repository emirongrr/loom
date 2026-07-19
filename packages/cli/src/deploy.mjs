// Read-only deployment inspection and verification for the `loom` CLI.
//
// These commands orchestrate the tested @loom/core and @loom/deployment
// primitives — schema parsing, the canonical manifest hash, and on-chain
// code-hash verification — and never reimplement them. They are read-only:
// nothing signs, sends, or mutates, and no network is touched unless an RPC URL
// is supplied. The signer-driven verbs (plan / apply / resume) are a separate
// concern and not part of this module.

import { manifestHash, parseDeploymentManifest } from "@loom/core";
import { createJsonRpcClient, verifyManifestOnChain } from "@loom/deployment";

const lower = value => String(value).toLowerCase();

// Parse + schema-validate a manifest and, when an RPC is supplied, confirm every
// component's code hash on chain. Throws (exit 6) on a schema or on-chain
// mismatch. Returns the structured report.
export async function validateManifest(manifestJson, { rpc } = {}) {
  let manifest;
  try {
    manifest = parseDeploymentManifest(manifestJson);
  } catch (error) {
    throw Object.assign(new Error(`manifest is invalid: ${error.message}`), { exitCode: 6 });
  }
  const report = {
    schemaValid: true,
    manifestHash: manifestHash(manifest),
    chainId: manifest.chainId,
    releaseChannel: manifest.releaseChannel,
    onChain: null
  };
  if (rpc) {
    const result = await verifyManifestOnChain({ rpc, manifest });
    report.onChain = { ok: result.ok, checks: result.checks, failures: result.failures.map(f => f.label) };
    if (!result.ok) {
      throw Object.assign(new Error(`on-chain verification failed: ${report.onChain.failures.join(", ")}`), {
        exitCode: 6,
        report
      });
    }
  }
  return report;
}

// Compare two manifests and classify the differences. Changes to the EntryPoint,
// factory, account implementation, or a validator/recovery module are
// authority-affecting (breaking); a chain-id change is incompatible; hook and
// metadata changes are notable but non-breaking.
export function diffManifests(oldJson, newJson) {
  const a = parseDeploymentManifest(oldJson);
  const b = parseDeploymentManifest(newJson);
  const changes = [];
  const add = (field, severity, from, to) => changes.push({ field, severity, from, to });

  if (a.chainId !== b.chainId) add("chainId", "incompatible", a.chainId, b.chainId);
  if (a.releaseChannel !== b.releaseChannel) add("releaseChannel", "notable", a.releaseChannel, b.releaseChannel);

  const contract = (field, x, y, severity) => {
    if (lower(x.address) !== lower(y.address)) add(`${field}.address`, severity, x.address, y.address);
    if (lower(x.runtimeCodeHash) !== lower(y.runtimeCodeHash)) add(`${field}.runtimeCodeHash`, severity, x.runtimeCodeHash, y.runtimeCodeHash);
  };
  contract("entryPoint", a.entryPoint, b.entryPoint, "breaking");
  contract("factory", a.factory, b.factory, "breaking");
  contract("account.implementation", a.account.implementation, b.account.implementation, "breaking");

  // Modules keyed by (type, address); a validator/recovery add/remove/change is
  // authority-affecting, a hook change is notable.
  const key = m => `${m.type}:${lower(m.address)}`;
  const severityFor = type => (type === "hook" ? "notable" : "breaking");
  const am = new Map(a.modules.map(m => [key(m), m]));
  const bm = new Map(b.modules.map(m => [key(m), m]));
  for (const [k, m] of am) if (!bm.has(k)) add(`module.${m.type}`, severityFor(m.type), m.address, null);
  for (const [k, m] of bm) if (!am.has(k)) add(`module.${m.type}`, severityFor(m.type), null, m.address);
  for (const [k, m] of am) {
    const n = bm.get(k);
    if (n && lower(m.runtimeCodeHash) !== lower(n.runtimeCodeHash)) add(`module.${m.type}.runtimeCodeHash`, severityFor(m.type), m.runtimeCodeHash, n.runtimeCodeHash);
  }

  const breaking = changes.some(c => c.severity === "breaking" || c.severity === "incompatible");
  return { compatible: !breaking, changes, from: manifestHash(a), to: manifestHash(b) };
}

// A structured view of a manifest, labelling each contract "verified" when its
// code hash was confirmed on chain (an RPC was supplied) or "asserted" when the
// manifest is the only source.
export async function inspectManifest(manifestJson, { rpc } = {}) {
  const manifest = parseDeploymentManifest(manifestJson);
  let verifiedAddresses = null;
  if (rpc) {
    const result = await verifyManifestOnChain({ rpc, manifest });
    verifiedAddresses = new Set(result.checks.filter(c => c.ok).map(c => lower(c.address)));
  }
  const label = address => (verifiedAddresses === null ? "asserted" : verifiedAddresses.has(lower(address)) ? "verified" : "unverified");
  return {
    manifestHash: manifestHash(manifest),
    chainId: manifest.chainId,
    releaseChannel: manifest.releaseChannel,
    contractRelease: manifest.compatibility.contractRelease,
    sdkRange: manifest.compatibility.sdkRange,
    entryPoint: { address: manifest.entryPoint.address, state: label(manifest.entryPoint.address) },
    factory: { address: manifest.factory.address, state: label(manifest.factory.address) },
    implementation: { address: manifest.account.implementation.address, state: label(manifest.account.implementation.address) },
    modules: manifest.modules.map(m => ({ type: m.type, address: m.address, version: m.version, status: m.status, state: label(m.address) }))
  };
}

// Verify a deployment's code hashes on chain; fails (exit 6) on any mismatch.
export async function verifyDeployment(manifestJson, rpc) {
  const manifest = parseDeploymentManifest(manifestJson);
  const result = await verifyManifestOnChain({ rpc, manifest });
  const report = {
    ok: result.ok,
    manifestHash: result.manifestHash,
    checks: result.checks,
    failures: result.failures.map(f => f.label)
  };
  if (!result.ok) {
    throw Object.assign(new Error(`deployment verification failed: ${report.failures.join(", ")}`), { exitCode: 6, report });
  }
  return report;
}

// Build an RPC client for the CLI (thin wrapper over the deployment primitive).
export function rpcClient(rpcUrl) {
  return createJsonRpcClient(rpcUrl);
}
