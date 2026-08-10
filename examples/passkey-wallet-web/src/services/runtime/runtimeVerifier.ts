import { keccak256, type Address, type Hex } from "viem";
import { AppError } from "../../domain/errors/appError.ts";
import type { NetworkConfig } from "../../config/network";
import type { WalletDeployment } from "../../features/onboarding/accountLifecycle";
import type { PublicClientRegistry } from "../rpc/publicClients";

export interface RuntimeVerifier {
  verify(config: NetworkConfig, deployment: WalletDeployment): Promise<void>;
}

export function createRuntimeVerifier(input: {
  publicClients: PublicClientRegistry;
  request?: typeof fetch;
}): RuntimeVerifier {
  const verified = new Set<string>();
  const request = input.request ?? fetch;
  return Object.freeze({
    async verify(config: NetworkConfig, deployment: WalletDeployment) {
      // A URL comparison, and only that. Two different URLs can front the same
      // provider, in which case corroboration proves less than it appears to;
      // the wallet cannot tell, and says so here rather than implying the two
      // endpoints are known to be operated separately.
      if (config.rpcUrl === config.verificationRpcUrl) {
        throw configurationError("The primary and verification RPC endpoints must be independent.");
      }
      const cacheKey = `${config.rpcUrl}:${config.verificationRpcUrl}:${config.bundlerUrl}:${deploymentFingerprint(deployment)}`;
      if (verified.has(cacheKey)) return;
      const clients = [
        input.publicClients.forEndpoint(config.rpcUrl),
        input.publicClients.forEndpoint(config.verificationRpcUrl)
      ] as const;
      const [chainIds, supportedEntryPoints] = await Promise.all([
        Promise.all(clients.map(client => client.getChainId())),
        readSupportedEntryPoints(request, config.bundlerUrl)
      ]);
      if (chainIds.some(chainId => chainId !== deployment.chainId)) throw configurationError("RPC chain does not match the deployment manifest.", { expectedChainId: deployment.chainId, primaryChainId: chainIds[0]!, verificationChainId: chainIds[1]! });
      if (!supportedEntryPoints.some(value => value.toLowerCase() === deployment.entryPoint.toLowerCase())) {
        throw configurationError("The bundler does not support this deployment's EntryPoint.");
      }
      // One request per distinct address per endpoint, all in flight together.
      // This was a round trip per commitment per endpoint, awaited in sequence:
      // a manifest can name eleven commitments, so twenty-two serial requests
      // stood between opening the wallet and seeing anything, and an address
      // named twice was fetched twice.
      const commitments = runtimeCommitments(deployment);
      const codeByAddress = new Map(await Promise.all(
        [...new Set(commitments.map(([address]) => address.toLowerCase()))]
          .map(async address => [
            address,
            await Promise.all(clients.map(client => client.getCode({ address: address as Address })))
          ] as const)
      ));
      // Checked in commitment order, so the first mismatch reported is the same
      // one the sequential version reported.
      for (const [address, expectedHash, label] of commitments) {
        const codes = codeByAddress.get(address.toLowerCase()) ?? [];
        if (
          codes.length === 0
          || codes.some(code => !code || code === "0x" || keccak256(code).toLowerCase() !== expectedHash.toLowerCase())
        ) {
          throw configurationError(`${label} bytecode does not match the trusted deployment profile.`);
        }
      }
      verified.add(cacheKey);
    }
  });
}

function deploymentFingerprint(deployment: WalletDeployment): string {
  return JSON.stringify({
    chainId: deployment.chainId,
    entryPoint: deployment.entryPoint.toLowerCase(),
    factory: deployment.factory.toLowerCase(),
    implementation: deployment.implementation.toLowerCase(),
    validator: deployment.validator.toLowerCase(),
    policyHook: deployment.policyHook.toLowerCase(),
    recoveryModule: deployment.recoveryModule?.toLowerCase(),
    guardianVerifiers: deployment.guardianVerifiers,
    runtimeCodeHashes: deployment.runtimeCodeHashes,
    recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner
  });
}

function runtimeCommitments(deployment: WalletDeployment): readonly [Address, Hex, string][] {
  const values: [Address, Hex, string][] = [
    [deployment.entryPoint, deployment.runtimeCodeHashes.entryPoint, "EntryPoint"],
    [deployment.factory, deployment.runtimeCodeHashes.factory, "Account factory"],
    [deployment.implementation, deployment.runtimeCodeHashes.implementation, "Account implementation"],
    [deployment.validator, deployment.runtimeCodeHashes.validator, "Passkey validator"],
    [deployment.policyHook, deployment.runtimeCodeHashes.policyHook, "Policy hook"]
  ];
  if (deployment.recoveryModule && deployment.runtimeCodeHashes.recoveryModule) values.push([deployment.recoveryModule, deployment.runtimeCodeHashes.recoveryModule, "Recovery module"]);
  const guardians = [
    [deployment.guardianVerifiers?.ecdsa, deployment.runtimeCodeHashes.ecdsaGuardianVerifier, "ECDSA guardian verifier"],
    [deployment.guardianVerifiers?.p256, deployment.runtimeCodeHashes.p256GuardianVerifier, "P-256 guardian verifier"],
    [deployment.guardianVerifiers?.erc1271, deployment.runtimeCodeHashes.erc1271GuardianVerifier, "ERC-1271 guardian verifier"]
  ] as const;
  for (const [address, hash, label] of guardians) if (address && hash) values.push([address, hash, label]);
  if (deployment.recoveryValidatorProvisioner) {
    values.push([
      deployment.recoveryValidatorProvisioner.address,
      deployment.recoveryValidatorProvisioner.runtimeCodeHash,
      "Recovery validator provisioner"
    ]);
    if (deployment.recoveryValidatorProvisioner.fallbackVerifierRuntimeCodeHash) {
      values.push([
        deployment.recoveryValidatorProvisioner.fallbackVerifier,
        deployment.recoveryValidatorProvisioner.fallbackVerifierRuntimeCodeHash,
        "Recovery validator fallback verifier"
      ]);
    }
  }
  return values;
}

async function readSupportedEntryPoints(request: typeof fetch, endpoint: string): Promise<readonly string[]> {
  const response = await request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints", params: [] })
  });
  if (!response.ok) throw configurationError("The bundler capability check failed.");
  const body = await response.json() as { result?: unknown };
  if (!Array.isArray(body.result) || !body.result.every(value => typeof value === "string")) throw configurationError("The bundler returned an invalid capability response.");
  return body.result;
}

function configurationError(userMessage: string, metadata?: Record<string, string | number | boolean>): AppError {
  return new AppError({
    code: "CONFIGURATION_ERROR",
    userMessage,
    diagnostic: userMessage,
    retryable: true,
    stage: "configuration",
    ...(metadata ? { metadata } : {})
  });
}
