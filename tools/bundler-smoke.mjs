const [bundlerUrl, expectedEntryPoint] = process.argv.slice(2);

if (!bundlerUrl || !expectedEntryPoint) {
  throw new Error("usage: node tools/bundler-smoke.mjs <bundler-url> <entrypoint>");
}

async function rpc(method, params = []) {
  const response = await fetch(bundlerUrl, {
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
if (!supported.map(value => value.toLowerCase()).includes(expectedEntryPoint.toLowerCase())) {
  throw new Error(`expected EntryPoint not supported: ${expectedEntryPoint}`);
}

const chainId = await rpc("eth_chainId");
console.log(JSON.stringify({bundlerUrl: new URL(bundlerUrl).origin, chainId, supportedEntryPoints: supported}, null, 2));
