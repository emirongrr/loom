import type { Hex, MobileWalletConfiguration, ReleaseGate } from "../../types/wallet";

// Deployment manifest verification.
//
// A wallet must never trust a contract address just because it arrived through
// an environment variable. This module lets an app pin the exact addresses and
// code hashes it expects for a chain, and refuse to proceed when the configured
// addresses do not match a committed manifest. The manifest is data the app
// bundles per network; the verifier below is a pure function so it can run in
// the client and in tests.
//
// This does NOT verify on-chain code hashes by itself — that requires a state
// read (see the Helios runtime). It verifies that the addresses the app is
// about to use are the ones the maintainers committed to, and that the manifest
// carries the code hashes a production build must check on chain. See
// docs/DEPLOYMENT.md.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export interface DeploymentManifest {
  readonly chainId: number;
  readonly entryPoint: Hex;
  readonly accountFactory: Hex;
  readonly passkeyValidator: Hex;
  readonly p256Verifier?: Hex;
  readonly p256VerifierMode: "native-precompile" | "fallback-contract";
  readonly codehashes: Readonly<Record<string, Hex>>;
  readonly deploymentBlock?: number | null;
  readonly explorerVerification?: Readonly<Record<string, string>>;
  readonly notes?: string;
}

export class DeploymentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentManifestError";
  }
}

/**
 * Parses and structurally validates a deployment manifest. Throws on malformed
 * input rather than returning a partially-trusted object.
 */
export function parseDeploymentManifest(input: unknown): DeploymentManifest {
  if (typeof input !== "object" || input === null) {
    throw new DeploymentManifestError("manifest must be an object");
  }
  const m = input as Record<string, unknown>;

  if (!Number.isSafeInteger(m.chainId) || (m.chainId as number) <= 0) {
    throw new DeploymentManifestError("manifest chainId must be a positive integer");
  }
  const address = (key: string, required: boolean): Hex | undefined => {
    const value = m[key];
    if (value === undefined) {
      if (required) throw new DeploymentManifestError(`manifest ${key} is required`);
      return undefined;
    }
    if (typeof value !== "string" || !ADDRESS.test(value)) {
      throw new DeploymentManifestError(`manifest ${key} must be a 20-byte address`);
    }
    return value as Hex;
  };

  const mode = m.p256VerifierMode;
  if (mode !== "native-precompile" && mode !== "fallback-contract") {
    throw new DeploymentManifestError("manifest p256VerifierMode must be native-precompile or fallback-contract");
  }
  if (mode === "fallback-contract" && !m.p256Verifier) {
    throw new DeploymentManifestError("fallback-contract mode requires a p256Verifier address");
  }

  const codehashes = m.codehashes;
  if (typeof codehashes !== "object" || codehashes === null) {
    throw new DeploymentManifestError("manifest codehashes must be an object");
  }
  const hashes: Record<string, Hex> = {};
  for (const [name, hash] of Object.entries(codehashes as Record<string, unknown>)) {
    if (typeof hash !== "string" || !HASH.test(hash)) {
      throw new DeploymentManifestError(`manifest codehash for ${name} must be a 32-byte hash`);
    }
    hashes[name] = hash as Hex;
  }

  return {
    chainId: m.chainId as number,
    entryPoint: address("entryPoint", true) as Hex,
    accountFactory: address("accountFactory", true) as Hex,
    passkeyValidator: address("passkeyValidator", true) as Hex,
    p256Verifier: address("p256Verifier", false),
    p256VerifierMode: mode,
    codehashes: Object.freeze(hashes),
    deploymentBlock: typeof m.deploymentBlock === "number" ? m.deploymentBlock : null,
    explorerVerification:
      typeof m.explorerVerification === "object" && m.explorerVerification !== null
        ? Object.freeze({ ...(m.explorerVerification as Record<string, string>) })
        : undefined,
    notes: typeof m.notes === "string" ? m.notes : undefined
  };
}

const eq = (a: Hex | undefined, b: Hex | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Verifies that the addresses the app is configured to use match a committed
 * manifest for the active chain. Returns a blocked gate for every mismatch so
 * the UI can refuse to deploy against unverified addresses. A production build
 * must additionally confirm the manifest code hashes on chain.
 */
export function verifyDeploymentAgainstManifest(
  config: MobileWalletConfiguration,
  manifest: DeploymentManifest
): readonly ReleaseGate[] {
  const gates: ReleaseGate[] = [];
  const blocked = (id: string, summary: string): void => {
    gates.push({ id, title: "Deployment does not match manifest", status: "blocked", summary });
  };

  if (config.network.chainId !== manifest.chainId) {
    blocked(
      "deployment.manifest.chain",
      `Configured chainId ${config.network.chainId} does not match manifest chainId ${manifest.chainId}.`
    );
  }
  if (config.network.entryPoint && !eq(config.network.entryPoint, manifest.entryPoint)) {
    blocked("deployment.manifest.entrypoint", "Configured EntryPoint does not match the manifest.");
  }
  if (config.deployment.accountFactory && !eq(config.deployment.accountFactory, manifest.accountFactory)) {
    blocked("deployment.manifest.factory", "Configured account factory does not match the manifest.");
  }
  if (config.deployment.passkeyValidator && !eq(config.deployment.passkeyValidator, manifest.passkeyValidator)) {
    blocked("deployment.manifest.validator", "Configured passkey validator does not match the manifest.");
  }
  if (config.deployment.p256VerifierMode !== "not-configured" && config.deployment.p256VerifierMode !== manifest.p256VerifierMode) {
    blocked("deployment.manifest.p256-mode", "Configured P-256 verifier mode does not match the manifest.");
  }
  if (
    manifest.p256VerifierMode === "fallback-contract" &&
    config.deployment.p256VerifierAddress &&
    !eq(config.deployment.p256VerifierAddress, manifest.p256Verifier)
  ) {
    blocked("deployment.manifest.p256-address", "Configured P-256 fallback verifier does not match the manifest.");
  }
  if (Object.keys(manifest.codehashes).length === 0) {
    blocked(
      "deployment.manifest.codehashes",
      "Manifest carries no code hashes; a production build cannot confirm on-chain bytecode."
    );
  }
  return gates;
}
