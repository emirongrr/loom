import type { Address, Hex } from "@loom/core";

export interface WalletDeployment {
  readonly chainId: number;
  readonly entryPoint: Address;
  readonly factory: Address;
  readonly implementation: Address;
  readonly validator: Address;
  readonly policyHook: Address;
  readonly proxyCreationCode: Hex;
  readonly runtimeCodeHashes: {
    readonly entryPoint: Hex;
    readonly factory: Hex;
    readonly implementation: Hex;
    readonly validator: Hex;
    readonly policyHook: Hex;
    readonly recoveryModule?: Hex;
    readonly ecdsaGuardianVerifier?: Hex;
    readonly p256GuardianVerifier?: Hex;
    readonly erc1271GuardianVerifier?: Hex;
  };
  readonly recoveryModule?: Address;
  readonly guardianVerifiers?: { readonly ecdsa?: Address; readonly erc1271?: Address; readonly p256?: Address };
  readonly recoveryValidatorProvisioner?: {
    readonly address: Address;
    readonly runtimeCodeHash: Hex;
    readonly validatorRuntimeCodeHash: Hex;
    readonly fallbackVerifier: Address;
  };
}

export async function loadWalletDeployment(
  request: typeof fetch = fetch,
  source = "/sepolia.deployment.json"
): Promise<WalletDeployment> {
  const response = await request(source, { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`deployment configuration returned ${response.status}`);
  return validateDeployment(await response.json());
}

export function validateDeployment(value: unknown): WalletDeployment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment configuration is invalid");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.chainId) || Number(record.chainId) <= 0) throw new Error("deployment chain is invalid");
  for (const field of ["entryPoint", "factory", "implementation", "validator", "policyHook"] as const) {
    if (!address(record[field])) throw new Error(`deployment ${field} is invalid`);
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(record.proxyCreationCode))) throw new Error("deployment proxy creation code is invalid");
  if (record.recoveryModule !== undefined && !address(record.recoveryModule)) throw new Error("deployment recovery module is invalid");
  const verifiers = parseGuardianVerifiers(record.guardianVerifiers);
  const recoveryValidatorProvisioner = parseRecoveryValidatorProvisioner(record.recoveryValidatorProvisioner);
  return Object.freeze({
    chainId: Number(record.chainId),
    entryPoint: record.entryPoint as Address,
    factory: record.factory as Address,
    implementation: record.implementation as Address,
    validator: record.validator as Address,
    policyHook: record.policyHook as Address,
    proxyCreationCode: record.proxyCreationCode as Hex,
    runtimeCodeHashes: parseRuntimeCodeHashes(record.runtimeCodeHashes),
    ...(record.recoveryModule === undefined ? {} : { recoveryModule: record.recoveryModule as Address }),
    ...(verifiers ? { guardianVerifiers: verifiers } : {}),
    ...(recoveryValidatorProvisioner ? { recoveryValidatorProvisioner } : {})
  });
}

function parseRuntimeCodeHashes(value: unknown): WalletDeployment["runtimeCodeHashes"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment runtime code hashes are required");
  const record = value as Record<string, unknown>;
  const required = ["entryPoint", "factory", "implementation", "validator", "policyHook"] as const;
  for (const field of required) if (!bytes32(record[field])) throw new Error(`deployment ${field} runtime code hash is invalid`);
  const optional = ["recoveryModule", "ecdsaGuardianVerifier", "p256GuardianVerifier", "erc1271GuardianVerifier"] as const;
  for (const field of optional) if (record[field] !== undefined && !bytes32(record[field])) throw new Error(`deployment ${field} runtime code hash is invalid`);
  return Object.freeze({
    entryPoint: record.entryPoint as Hex,
    factory: record.factory as Hex,
    implementation: record.implementation as Hex,
    validator: record.validator as Hex,
    policyHook: record.policyHook as Hex,
    ...Object.fromEntries(optional.filter(field => record[field] !== undefined).map(field => [field, record[field] as Hex]))
  });
}

function parseRecoveryValidatorProvisioner(value: unknown): WalletDeployment["recoveryValidatorProvisioner"] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("deployment recovery validator provisioner is invalid");
  const record = value as Record<string, unknown>;
  if (!address(record.address)) throw new Error("deployment recovery validator provisioner address is invalid");
  if (!bytes32(record.runtimeCodeHash)) throw new Error("deployment recovery validator provisioner code hash is invalid");
  if (!bytes32(record.validatorRuntimeCodeHash)) throw new Error("deployment recovery validator code hash is invalid");
  if (!address(record.fallbackVerifier)) throw new Error("deployment recovery validator fallback verifier is invalid");
  return Object.freeze({
    address: record.address as Address,
    runtimeCodeHash: record.runtimeCodeHash as Hex,
    validatorRuntimeCodeHash: record.validatorRuntimeCodeHash as Hex,
    fallbackVerifier: record.fallbackVerifier as Address
  });
}

function parseGuardianVerifiers(value: unknown): WalletDeployment["guardianVerifiers"] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("deployment guardian verifiers are invalid");
  const record = value as Record<string, unknown>;
  const verifiers: Record<string, Address> = {};
  for (const kind of ["ecdsa", "erc1271", "p256"] as const) {
    const candidate = record[kind];
    if (candidate === undefined || candidate === null) continue;
    if (!address(candidate)) throw new Error(`deployment ${kind} guardian verifier is invalid`);
    verifiers[kind] = candidate as Address;
  }
  return Object.keys(verifiers).length > 0 ? Object.freeze(verifiers) : null;
}

function bytes32(value: unknown): boolean { return /^0x[0-9a-fA-F]{64}$/.test(String(value)); }
function address(value: unknown): boolean { return /^0x[0-9a-fA-F]{40}$/.test(String(value)); }
