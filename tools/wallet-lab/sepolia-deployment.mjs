import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { buildDeploymentEvidence } from "./deployment-evidence.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const MAX_RPC_RESPONSE_BYTES = 1_000_000;

function rpcFailure(code, message, metadata = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, metadata);
  return error;
}

const COMPONENTS = Object.freeze([
  ["EntryPoint", "entryPoint", "entryPoint"],
  ["LoomAccountFactory", "factory", "factory"],
  ["LoomAccount", "implementation", "implementation"],
  ["P256Validator", "validator", "validator"],
  ["PolicyHook", "policyHook", "policyHook"],
  ["RecoveryManager", "recoveryModule", "recoveryModule"],
  ["RecoveryIntentBoard", "recoveryIntentBoard", "recoveryIntentBoard", true],
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
  for (const [, addressPath, hashPath, optional = false] of COMPONENTS) {
    const address = at(manifest, addressPath);
    const expectedHash = hashPath.startsWith("recoveryValidatorProvisioner.") ? at(manifest, hashPath) : manifest.runtimeCodeHashes?.[hashPath];
    if (optional && address === undefined && expectedHash === undefined) continue;
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
      if (!response.ok) throw rpcFailure("RPC_HTTP_ERROR", "The Sepolia RPC returned an unsuccessful HTTP response", { httpStatus: response.status });
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_RPC_RESPONSE_BYTES) throw rpcFailure("RPC_RESPONSE_TOO_LARGE", "Sepolia RPC response exceeded the size limit");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RPC_RESPONSE_BYTES) throw rpcFailure("RPC_RESPONSE_TOO_LARGE", "Sepolia RPC response exceeded the size limit");
      const payload = JSON.parse(text);
      if (payload?.error) {
        const rpcError = rpcFailure("RPC_REJECTED", "RPC rejected the requested operation");
        rpcError.rpcCode = payload.error.code;
        rpcError.rpcData = typeof payload.error.data === "string" ? payload.error.data : null;
        throw rpcError;
      }
      if (!("result" in (payload ?? {}))) throw rpcFailure("RPC_INVALID_RESPONSE", "Sepolia RPC returned an invalid response");
      return payload.result;
    } catch (error) {
      if (error?.name === "AbortError") throw rpcFailure("RPC_TIMEOUT", "Sepolia RPC request timed out");
      if (String(error?.code ?? "").startsWith("RPC_")) throw error;
      throw rpcFailure("RPC_UNREACHABLE", "The Sepolia RPC could not be reached");
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
  for (const [name, addressPath, hashPath, optional = false] of COMPONENTS) {
    const address = at(manifest, addressPath);
    const expected = hashPath.startsWith("recoveryValidatorProvisioner.") ? at(manifest, hashPath) : manifest.runtimeCodeHashes[hashPath];
    if (optional && address === undefined && expected === undefined) continue;
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
