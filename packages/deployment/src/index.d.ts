import type { LoomDeploymentManifest } from "@loom/core";

export type Hex = `0x${string}`;
export type P256VerifierMode = "native-precompile" | "fallback-contract";

/** Versioned manifest schema; bumped on breaking manifest shape changes. */
export const MANIFEST_SCHEMA_VERSION: number;
/** EIP-7951 native P-256 precompile address (same on every supporting chain). */
export const NATIVE_P256_PRECOMPILE: Hex;
export const DEFAULT_CONTRACTS: Readonly<Record<"accountFactory" | "passkeyValidator" | "accountImplementation", string>>;

export type JsonRpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface ParsedFoundryBroadcast {
  readonly chainId: number;
  readonly sourceCommit?: string;
  readonly addresses: Readonly<{
    accountFactory: Hex;
    passkeyValidator: Hex;
    accountImplementation: Hex;
  }>;
  readonly createdContracts: Readonly<Record<string, Hex>>;
  readonly transactionHashes: Readonly<Record<string, Hex>>;
}

export interface WalletDeploymentManifest {
  readonly schemaVersion: number;
  readonly chainId: number;
  readonly deployedAt: string;
  readonly sourceCommit: string | null;
  readonly entryPoint: Hex;
  readonly accountFactory: Hex;
  readonly passkeyValidator: Hex;
  readonly p256Verifier: Hex;
  readonly p256VerifierMode: P256VerifierMode;
  readonly codehashes: Readonly<Record<string, Hex>>;
  readonly deploymentBlock: number | null;
  readonly notes: string;
}

export interface P256ProbeResult {
  readonly supported: boolean;
  readonly valid: unknown;
  readonly invalid: unknown;
}

export interface VerificationCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DeploymentVerification {
  readonly manifest: WalletDeploymentManifest;
  readonly env: Readonly<Record<string, string>>;
  readonly checks: readonly VerificationCheck[];
  readonly failures: readonly VerificationCheck[];
}

export function parseFoundryBroadcast(
  broadcast: unknown,
  options?: { contracts?: Record<string, string> }
): ParsedFoundryBroadcast;

export function buildWalletDeploymentManifest(options: {
  broadcast: unknown;
  rpc: JsonRpcCall;
  entryPoint: Hex;
  p256VerifierMode?: P256VerifierMode;
  p256Verifier?: Hex;
  probeP256?: () => Promise<P256ProbeResult>;
  deploymentBlock?: number | null;
  deployedAt?: string;
  notes?: string;
  contracts?: Record<string, string>;
}): Promise<WalletDeploymentManifest>;

export function buildCanonicalDeploymentManifest(options: {
  broadcast?: unknown;
  parsed?: ParsedFoundryBroadcast;
  rpc: JsonRpcCall;
  entryPoint: Hex;
  releaseChannel?: "devnet" | "testnet" | "mainnet";
  compatibility: { contractRelease: string; sdkRange: string };
  proxyArtifact: { bytecode: { object: Hex }; deployedBytecode: { object: Hex } };
  moduleStatus?: "stable" | "beta" | "experimental";
  extraModules?: readonly unknown[];
  contracts?: Record<string, string>;
}): Promise<{ manifest: LoomDeploymentManifest; manifestHash: Hex }>;

export function verifyManifestOnChain(options: {
  rpc: JsonRpcCall;
  manifest: LoomDeploymentManifest | unknown;
}): Promise<{
  readonly ok: boolean;
  readonly manifestHash: Hex;
  readonly checks: readonly { label: string; address: Hex; ok: boolean }[];
  readonly failures: readonly { label: string; address: Hex; ok: boolean }[];
}>;

export function bindWalletManifestToCanonical(
  appManifest: WalletDeploymentManifest,
  canonicalManifest: LoomDeploymentManifest | unknown
): WalletDeploymentManifest & { readonly sourceManifestHash: Hex };

export function envForWalletDeployment(
  manifest: WalletDeploymentManifest,
  manifestReference: string
): Readonly<Record<string, string>>;

export function writeWalletDeploymentFiles(options: {
  manifest: WalletDeploymentManifest;
  manifestPath: string;
  envPath: string;
  manifestReference: string;
}): Promise<{ manifestPath: string; envPath: string; envUpdates: Readonly<Record<string, string>> }>;

export function verifyWalletDeploymentFiles(options: {
  manifestPath: string;
  envPath: string;
  rpc: JsonRpcCall;
  accountImplementation?: Hex;
  probeP256?: () => Promise<P256ProbeResult>;
}): Promise<DeploymentVerification>;

export function connectWalletAppDeployment(options: {
  broadcastPath: string;
  manifestPath: string;
  envPath: string;
  manifestReference: string;
  rpc: JsonRpcCall;
  entryPoint: Hex;
  p256VerifierMode?: P256VerifierMode;
  p256Verifier?: Hex;
  probeP256?: () => Promise<P256ProbeResult>;
  notes?: string;
  contracts?: Record<string, string>;
}): Promise<{
  manifest: WalletDeploymentManifest;
  verification: DeploymentVerification;
  parsed: ParsedFoundryBroadcast;
}>;

export interface DeploymentGasEntry {
  readonly contractName: string;
  readonly address: Hex | null;
  readonly gasUsed: number;
}

export interface DeploymentGasReport {
  readonly contracts: readonly DeploymentGasEntry[];
  readonly totalGas: number;
}

/** Per-contract deployment gas from a Foundry broadcast, matched by tx hash. */
export function deploymentGasReport(
  broadcast: unknown,
  options?: { exclude?: readonly string[] }
): DeploymentGasReport;

export function createJsonRpcClient(rpcUrl: string): JsonRpcCall;

/** Live EIP-7951 probe: fresh software P-256 vector verified via eth_call. */
export function probeP256Precompile(rpc: JsonRpcCall): Promise<P256ProbeResult>;

export function runFoundryDeployment(options: {
  repoRoot: string;
  script: string;
  rpcUrl: string;
  chainId: number;
  forgeBin?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  stdio?: "inherit" | "pipe" | "ignore";
  spawn?: unknown;
}): Promise<{ broadcastPath: string; forgeBin: string }>;

export function saveDeploymentRecord(options: {
  directory: string;
  manifest: WalletDeploymentManifest;
  parsed: ParsedFoundryBroadcast;
}): Promise<{ recordPath: string; record: unknown }>;

export function loadDeploymentRecord(options: {
  directory: string;
  chainId: number;
}): Promise<unknown | undefined>;

export function deployAndConnectWallet(
  options: Parameters<typeof runFoundryDeployment>[0] &
    Omit<Parameters<typeof connectWalletAppDeployment>[0], "broadcastPath" | "rpc"> & {
      rpc?: JsonRpcCall;
      recordDirectory?: string;
    }
): Promise<{
  manifest: WalletDeploymentManifest;
  verification: DeploymentVerification;
  parsed: ParsedFoundryBroadcast;
  broadcastPath: string;
  recordPath?: string;
}>;
