import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { keccak256 } from "viem";
import { createJsonRpc, inspectSepoliaDeployment, rpcEndpointOrigin } from "../sepolia-deployment.mjs";

const CODE = "0x6001600055";
const HASH = keccak256(CODE);
const address = suffix => `0x${suffix.padStart(40, "0")}`;

function manifest() {
  return {
    chainId: 11155111,
    entryPoint: address("1"),
    factory: address("2"),
    implementation: address("3"),
    validator: address("4"),
    policyHook: address("5"),
    recoveryModule: address("6"),
    guardianVerifiers: { ecdsa: address("7"), p256: address("8"), erc1271: address("9") },
    recoveryValidatorProvisioner: {
      address: address("10"),
      runtimeCodeHash: HASH,
      validatorRuntimeCodeHash: HASH,
      fallbackVerifier: address("0")
    },
    runtimeCodeHashes: {
      entryPoint: HASH,
      factory: HASH,
      implementation: HASH,
      validator: HASH,
      policyHook: HASH,
      recoveryModule: HASH,
      ecdsaGuardianVerifier: HASH,
      p256GuardianVerifier: HASH,
      erc1271GuardianVerifier: HASH
    }
  };
}

test("Sepolia deployment inspection verifies chain identity and every published code hash", async () => {
  const report = await inspectSepoliaDeployment({
    repoRoot: new URL("../../../", import.meta.url),
    manifest: manifest(),
    rpc: async (method, params) => method === "eth_chainId" ? "0xaa36a7" : params[0] ? CODE : null,
    endpointOrigin: "https://rpc.example"
  });

  assert.equal(report.status, "verified");
  assert.equal(report.chainId, 11155111);
  assert.equal(report.checks.length, 10);
  assert.equal(report.deployment.nodes.length, 10);
  assert.ok(report.deployment.nodes.every(node => node.verification === "verified"));
});

test("Sepolia deployment inspection fails closed on chain or bytecode drift", async () => {
  const report = await inspectSepoliaDeployment({
    repoRoot: new URL("../../../", import.meta.url),
    manifest: manifest(),
    rpc: async (method, params) => method === "eth_chainId" ? "0xaa36a7" : params[0] === address("4") ? "0x6000" : CODE,
    endpointOrigin: "https://rpc.example"
  });

  assert.equal(report.status, "mismatch");
  assert.deepEqual(report.failures.map(item => item.label), ["P256Validator"]);
  assert.equal(report.deployment.nodes.find(node => node.id === "P256Validator").verification, "mismatch");
});

test("RPC endpoint reporting exposes only the origin", () => {
  const endpoint = "https://user:secret@rpc.example/v2/private-token?key=secret";
  assert.equal(rpcEndpointOrigin(endpoint), "https://rpc.example");
  assert.doesNotMatch(JSON.stringify({ endpoint: rpcEndpointOrigin(endpoint) }), /secret|private-token/u);
});

test("Sepolia RPC rejects oversized responses before parsing them", async () => {
  const rpc = createJsonRpc("https://rpc.example/private", {
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-length": "1000001" } })
  });
  await assert.rejects(() => rpc("eth_chainId"), /exceeded the size limit/u);
});

test("Wallet Lab UI exposes a local or verified Sepolia deployment choice", () => {
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(html, /id="deployment-source"/u);
  assert.match(html, /value="sepolia"/u);
  assert.match(script, /\/api\/deployments\/sepolia/u);
  assert.match(script, /Sepolia deployment is not configured/u);
});
