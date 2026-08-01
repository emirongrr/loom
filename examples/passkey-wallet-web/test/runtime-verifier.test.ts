import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, type Address, type Hex } from "viem";
import { AppError } from "../src/domain/errors/appError.ts";
import { createRuntimeVerifier } from "../src/services/runtime/runtimeVerifier.ts";
import { validateDeployment } from "../src/services/deployment/deploymentProfile.ts";

const CODE = "0x6001600055" as Hex;
const HASH = keccak256(CODE);
const ENTRY_POINT = "0x1111111111111111111111111111111111111111" as Address;
const ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const deployment = {
  chainId: 11155111,
  entryPoint: ENTRY_POINT,
  factory: ADDRESS,
  implementation: ADDRESS,
  validator: ADDRESS,
  policyHook: ADDRESS,
  proxyCreationCode: "0x60",
  runtimeCodeHashes: { entryPoint: HASH, factory: HASH, implementation: HASH, validator: HASH, policyHook: HASH }
} as const;
const config = { rpcUrl: "https://rpc.example", verificationRpcUrl: "https://verification-rpc.example", bundlerUrl: "https://bundler.example", explorerUrl: "https://explorer.example", relayUrl: "" } as const;

function verifier(input: { chainId?: number; entryPoints?: readonly string[]; code?: Hex } = {}) {
  const client = {
    getChainId: async () => input.chainId ?? deployment.chainId,
    getCode: async () => input.code ?? CODE
  };
  const request = (async () => new Response(JSON.stringify({ result: input.entryPoints ?? [ENTRY_POINT] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })) as typeof fetch;
  return createRuntimeVerifier({ publicClients: { forEndpoint: () => client as never }, request });
}

test("runtime verification binds chain, EntryPoint support, and manifest code hashes", async () => {
  await verifier().verify(config, deployment);
});

test("runtime verification rejects a chain mismatch before an operation", async () => {
  await assert.rejects(
    verifier({ chainId: 1 }).verify(config, deployment),
    (error: unknown) => error instanceof AppError && error.code === "CONFIGURATION_ERROR"
  );
});

test("runtime verification rejects unsupported EntryPoints and code drift", async () => {
  await assert.rejects(verifier({ entryPoints: [] }).verify(config, deployment), AppError);
  await assert.rejects(verifier({ code: "0x6000" }).verify(config, deployment), AppError);
});

test("runtime verification rejects disagreement between independent RPCs", async () => {
  const primary = { getChainId: async () => deployment.chainId, getCode: async () => CODE };
  const verifierClient = { getChainId: async () => deployment.chainId, getCode: async () => "0x6000" as Hex };
  const request = (async () => new Response(JSON.stringify({ result: [ENTRY_POINT] }), { status: 200 })) as typeof fetch;
  const runtime = createRuntimeVerifier({ publicClients: { forEndpoint: endpoint => endpoint === config.rpcUrl ? primary as never : verifierClient as never }, request });
  await assert.rejects(runtime.verify(config, deployment), AppError);
});

test("runtime verification cache is bound to the manifest commitments", async () => {
  let codeReads = 0;
  const client = { getChainId: async () => deployment.chainId, getCode: async () => { codeReads += 1; return CODE; } };
  const request = (async () => new Response(JSON.stringify({ result: [ENTRY_POINT] }), { status: 200 })) as typeof fetch;
  const runtime = createRuntimeVerifier({ publicClients: { forEndpoint: () => client as never }, request });
  await runtime.verify(config, deployment);
  const afterFirst = codeReads;
  await runtime.verify(config, deployment);
  assert.equal(codeReads, afterFirst);
  await assert.rejects(runtime.verify(config, { ...deployment, runtimeCodeHashes: { ...deployment.runtimeCodeHashes, factory: `0x${"ff".repeat(32)}` } }));
  assert.ok(codeReads > afterFirst);
});

test("optional authority addresses and hashes must be committed as pairs", () => {
  assert.throws(() => validateDeployment({ ...deployment, recoveryModule: ADDRESS }), /recoveryModule.*hash/i);
  assert.throws(() => validateDeployment({ ...deployment, runtimeCodeHashes: { ...deployment.runtimeCodeHashes, recoveryModule: HASH } }), /recoveryModule.*address/i);
  assert.throws(() => validateDeployment({ ...deployment, guardianVerifiers: { ecdsa: ADDRESS } }), /ecdsa.*hash/i);
});

test("the recovery provisioner runtime is verified", async () => {
  const provisioner = {
    address: "0x3333333333333333333333333333333333333333" as Address,
    runtimeCodeHash: HASH,
    validatorRuntimeCodeHash: HASH,
    fallbackVerifier: "0x4444444444444444444444444444444444444444" as Address,
    fallbackVerifierRuntimeCodeHash: HASH
  };
  let provisionerRead = false;
  let fallbackRead = false;
  const client = {
    getChainId: async () => deployment.chainId,
    getCode: async ({ address }: { address: Address }) => {
      if (address.toLowerCase() === provisioner.address.toLowerCase()) provisionerRead = true;
      if (address.toLowerCase() === provisioner.fallbackVerifier.toLowerCase()) fallbackRead = true;
      return CODE;
    }
  };
  const request = (async () => new Response(JSON.stringify({ result: [ENTRY_POINT] }), { status: 200 })) as typeof fetch;
  const runtime = createRuntimeVerifier({ publicClients: { forEndpoint: () => client as never }, request });
  await runtime.verify(config, { ...deployment, recoveryValidatorProvisioner: provisioner });
  assert.equal(provisionerRead, true);
  assert.equal(fallbackRead, true);
});
