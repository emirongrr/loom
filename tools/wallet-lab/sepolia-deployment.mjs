import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { buildDeploymentEvidence } from "./deployment-evidence.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const MAX_RPC_RESPONSE_BYTES = 1_000_000;

const COMPONENTS = Object.freeze([
  ["EntryPoint", "entryPoint", "entryPoint"],
  ["LoomAccountFactory", "factory", "factory"],
  ["LoomAccount", "implementation", "implementation"],
  ["P256Validator", "validator", "validator"],
  ["PolicyHook", "policyHook", "policyHook"],
  ["RecoveryManager", "recoveryModule", "recoveryModule"],
  ["ECDSAGuardianVerifier", "guardianVerifiers.ecdsa", "ecdsaGuardianVerifier"],
  ["P256GuardianVerifier", "guardianVerifiers.p256", "p256GuardianVerifier"],
  ["ERC1271GuardianVerifier", "guardianVerifiers.erc1271", "erc1271GuardianVerifier"],
  ["P256RecoveryValidatorFactory", "recoveryValidatorProvisioner.address", "recoveryValidatorProvisioner.runtimeCodeHash"]
]);

function at(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function requireProfile(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Sepolia deployment profile must be an object");
  if (manifest.chainId !== 11155111) throw new Error("Sepolia deployment profile must declare chainId 11155111");
  for (const [, addressPath, hashPath] of COMPONENTS) {
    const address = at(manifest, addressPath);
    const expectedHash = hashPath.startsWith("recoveryValidatorProvisioner.") ? at(manifest, hashPath) : manifest.runtimeCodeHashes?.[hashPath];
    if (!ADDRESS.test(address ?? "")) throw new Error(`Sepolia deployment profile has an invalid ${addressPath}`);
    if (!HASH.test(expectedHash ?? "")) throw new Error(`Sepolia deployment profile has an invalid ${hashPath} code hash`);
  }
  return manifest;
}

export function rpcEndpointOrigin(endpoint) {
  const parsed = new URL(endpoint);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("RPC endpoint must use HTTP or HTTPS");
  return parsed.origin;
}

export function createJsonRpc(endpoint, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  rpcEndpointOrigin(endpoint);
  let id = 0;
  return async (method, params = []) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Sepolia RPC request failed");
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_RPC_RESPONSE_BYTES) throw new Error("Sepolia RPC response exceeded the size limit");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RPC_RESPONSE_BYTES) throw new Error("Sepolia RPC response exceeded the size limit");
      const payload = JSON.parse(text);
      if (payload?.error) {
        const rpcError = new Error("RPC rejected the requested operation");
        rpcError.rpcCode = payload.error.code;
        rpcError.rpcData = typeof payload.error.data === "string" ? payload.error.data : null;
        throw rpcError;
      }
      if (!("result" in (payload ?? {}))) throw new Error("Sepolia RPC returned an invalid response");
      return payload.result;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Sepolia RPC request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function inspectSepoliaDeployment({ repoRoot, manifest: input, rpc, endpointOrigin }) {
  const manifest = requireProfile(input);
  if (typeof rpc !== "function") throw new Error("Sepolia RPC function is required");
  const observedChainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (observedChainId !== manifest.chainId) {
    return Object.freeze({ status: "mismatch", chainId: observedChainId, expectedChainId: manifest.chainId, endpointOrigin, checks: [], failures: [{ label: "chainId", expected: manifest.chainId, observed: observedChainId }], deployment: { nodes: [], edges: [] } });
  }

  const addresses = {};
  const codeHashes = {};
  const checks = [];
  for (const [name, addressPath, hashPath] of COMPONENTS) {
    const address = at(manifest, addressPath);
    const expected = hashPath.startsWith("recoveryValidatorProvisioner.") ? at(manifest, hashPath) : manifest.runtimeCodeHashes[hashPath];
    const code = await rpc("eth_getCode", [address, "latest"]);
    const observed = typeof code === "string" && code !== "0x" ? keccak256(code) : null;
    addresses[name] = address;
    codeHashes[name] = expected;
    checks.push({ label: name, address, expected, observed, ok: observed?.toLowerCase() === expected.toLowerCase() });
  }
  const failures = checks.filter(check => !check.ok);
  const root = repoRoot instanceof URL ? fileURLToPath(repoRoot) : repoRoot;
  const deployment = buildDeploymentEvidence({ repoRoot: root, addresses, codeHashes });
  const verification = new Map(checks.map(check => [check.label, check.ok ? "verified" : "mismatch"]));
  deployment.nodes = deployment.nodes.map(node => ({ ...node, verification: verification.get(node.id) ?? "unverified" }));
  return Object.freeze({
    status: failures.length ? "mismatch" : "verified",
    chainId: observedChainId,
    expectedChainId: manifest.chainId,
    endpointOrigin,
    checks,
    failures,
    deployment
  });
}
