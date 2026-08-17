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

test("a zero fallback verifier means no fallback authority or bytecode commitment", async () => {
  const provisioner = validateDeployment({
    ...deployment,
    recoveryValidatorProvisioner: {
      address: "0x3333333333333333333333333333333333333333",
      runtimeCodeHash: HASH,
      validatorRuntimeCodeHash: HASH,
      fallbackVerifier: "0x0000000000000000000000000000000000000000"
    }
  }).recoveryValidatorProvisioner!;
  const reads: Address[] = [];
  const client = {
    getChainId: async () => deployment.chainId,
    getCode: async ({ address }: { address: Address }) => { reads.push(address); return CODE; }
  };
  const request = (async () => new Response(JSON.stringify({ result: [ENTRY_POINT] }), { status: 200 })) as typeof fetch;
  await createRuntimeVerifier({ publicClients: { forEndpoint: () => client as never }, request }).verify(
    config,
    { ...deployment, recoveryValidatorProvisioner: provisioner }
  );
  assert.equal(reads.some(address => address === provisioner.fallbackVerifier), false);
  assert.throws(() => validateDeployment({
    ...deployment,
    recoveryValidatorProvisioner: { ...provisioner, fallbackVerifierRuntimeCodeHash: HASH }
  }), /no fallback verifier/u);
});

test("each distinct address is fetched once per endpoint, not once per commitment", async () => {
  // The fixture manifest names one address for factory, implementation,
  // validator and policy hook, which is exactly the shape that used to pay for
  // the same bytecode four times per endpoint.
  const requested: string[] = [];
  const client = {
    getChainId: async () => deployment.chainId,
    getCode: async ({ address }: { address: Address }) => { requested.push(address.toLowerCase()); return CODE; }
  };
  const request = (async () => new Response(JSON.stringify({ result: [ENTRY_POINT] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })) as typeof fetch;
  const runtime = createRuntimeVerifier({ publicClients: { forEndpoint: () => client as never }, request });

  await runtime.verify(config, deployment);

  const distinct = new Set(requested);
  assert.deepEqual([...distinct].sort(), [ENTRY_POINT.toLowerCase(), ADDRESS.toLowerCase()].sort());
  // Two endpoints share this stub client, so one call per address per endpoint.
  assert.equal(requested.length, distinct.size * 2, "an address was fetched more than once per endpoint");
});

test("the first mismatching commitment is still the one reported", async () => {
  const broken = { ...deployment, runtimeCodeHashes: { ...deployment.runtimeCodeHashes, factory: keccak256("0xdead"), policyHook: keccak256("0xbeef") } } as const;
  await assert.rejects(
    verifier().verify(config, broken),
    (error: unknown) => error instanceof AppError && error.userMessage.startsWith("Account factory")
  );
});

// An endpoint that does not answer and bytecode that does not match both stop
// the operation, but they are opposite findings: one says the chain is not what
// this build trusts, the other says nothing about the chain at all. Surfacing a
// raw transport error made the second read like the first.
test("an unreachable endpoint is reported as unreachable, not as code drift", async () => {
  const client = {
    getChainId: async () => deployment.chainId,
    getCode: async () => { throw new TypeError("Failed to fetch"); }
  };
  const request = (async () => new Response(JSON.stringify({ result: [ENTRY_POINT] }), {
    status: 200, headers: { "content-type": "application/json" }
  })) as typeof fetch;
  const subject = createRuntimeVerifier({ publicClients: { forEndpoint: () => client as never }, request });

  const error = await subject.verify(config, deployment).then(() => null, issue => issue as AppError);
  assert.ok(error instanceof AppError, "verification must fail closed when an endpoint cannot be reached");
  assert.equal(error.code, "CONFIGURATION_ERROR");
  assert.match(error.userMessage, /could not reach/);
  assert.doesNotMatch(error.userMessage, /does not match the trusted deployment profile/);
});

// Endpoint URLs carry API keys often enough that the message must not repeat
// one back into the interface or the logs.
test("an unreachable endpoint is named by host, never by full URL", async () => {
  const client = {
    getChainId: async () => { throw new Error("boom"); },
    getCode: async () => CODE
  };
  const request = (async () => new Response(JSON.stringify({ result: [ENTRY_POINT] }), {
    status: 200, headers: { "content-type": "application/json" }
  })) as typeof fetch;
  const subject = createRuntimeVerifier({ publicClients: { forEndpoint: () => client as never }, request });
  const secret = { ...config, rpcUrl: "https://rpc.example/v1/super-secret-key" };

  const error = await subject.verify(secret, deployment).then(() => null, issue => issue as AppError);
  assert.ok(error instanceof AppError);
  assert.match(error.userMessage, /rpc\.example/);
  assert.doesNotMatch(error.userMessage, /super-secret-key/);
});
