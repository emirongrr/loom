import { pathToFileURL } from "node:url";

export async function smokeBundler({ bundlerUrl, expectedEntryPoint, expectedChainId, fetch: fetchImpl = fetch }) {
  const origin = assertBundlerUrl(bundlerUrl);
  assertAddress(expectedEntryPoint, "expectedEntryPoint");
  const expectedChain = normalizeExpectedChainId(expectedChainId);

  async function rpc(method, params = []) {
    const response = await fetchImpl(bundlerUrl, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})
    });
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  const supported = await rpc("eth_supportedEntryPoints");
  if (!Array.isArray(supported)) throw new Error("eth_supportedEntryPoints must return an array");
  if (!supported.map(value => String(value).toLowerCase()).includes(expectedEntryPoint.toLowerCase())) {
    throw new Error(`expected EntryPoint not supported: ${expectedEntryPoint}`);
  }

  const chainId = await rpc("eth_chainId");
  const normalizedChainId = parseRpcChainId(chainId);
  if (normalizedChainId !== expectedChain) {
    throw new Error(`unexpected bundler chainId: ${chainId}`);
  }

  return Object.freeze({
    rpcOrigin: origin,
    chainId: normalizedChainId,
    entryPoint: expectedEntryPoint,
    supportedEntryPoints: Object.freeze(supported)
  });
}

export function assertBundlerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("bundler URL must be a valid URL");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("bundler URL must use http or https");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("bundler URL must not contain credentials, query, or fragment");
  }
  const text = value.toLowerCase();
  for (const marker of ["apikey=", "api_key=", "access_token=", "secret=", "token="]) {
    if (text.includes(marker)) throw new Error("bundler URL must not contain secret-bearing parameters");
  }
  return url.origin;
}

function normalizeExpectedChainId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return parseRpcChainId(value);
}

function parseRpcChainId(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("chainId must be a 0x-prefixed quantity without leading zeroes");
  }
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("chainId must be a positive safe integer");
  return parsed;
}

function assertAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error(`${label} must be a 20-byte address`);
}

async function main() {
  const [bundlerUrl, expectedEntryPoint, expectedChainId] = process.argv.slice(2);

  if (!bundlerUrl || !expectedEntryPoint || !expectedChainId) {
    throw new Error("usage: node tools/bundler-smoke.mjs <bundler-url> <entrypoint> <chain-id>");
  }

  const result = await smokeBundler({ bundlerUrl, expectedEntryPoint, expectedChainId });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
