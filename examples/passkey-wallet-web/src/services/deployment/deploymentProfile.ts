import type { Address, Hex } from "@loom/core";

export interface WalletDeployment {
  readonly schemaVersion: 2;
  readonly chainId: number;
  readonly entryPoint: Address;
  readonly factory: Address;
  readonly appRegistry: Address;
  readonly implementation: Address;
  readonly validator: Address;
  readonly policyHook: Address;
  readonly proxyCreationCode: Hex;
  readonly runtimeCodeHashes: {
    readonly entryPoint: Hex;
    readonly factory: Hex;
    readonly appRegistry: Hex;
    readonly implementation: Hex;
    readonly validator: Hex;
    readonly policyHook: Hex;
    readonly recoveryModule?: Hex;
    readonly recoveryIntentBoard?: Hex;
    readonly onboardingPaymaster?: Hex;
    readonly ecdsaGuardianVerifier?: Hex;
    readonly p256GuardianVerifier?: Hex;
    readonly erc1271GuardianVerifier?: Hex;
  };
  readonly recoveryModule?: Address;
  readonly onboardingPaymaster?: Address;
  /**
   * Optional discovery channel (ADR-0024). A deployment that omits it is fully
   * valid: the wallet simply has no on-chain recovery discovery, and the QR,
   * file, clipboard, and direct paths are unaffected.
   */
  readonly recoveryIntentBoard?: Address;
  readonly guardianVerifiers?: { readonly ecdsa?: Address; readonly erc1271?: Address; readonly p256?: Address };
  readonly recoveryValidatorProvisioner?: {
    readonly address: Address;
    readonly runtimeCodeHash: Hex;
    readonly validatorRuntimeCodeHash: Hex;
    readonly fallbackVerifier: Address;
    readonly fallbackVerifierRuntimeCodeHash?: Hex;
  };
  /** Optional application policy. Contracts remain usable without sponsorship. */
  readonly onboarding?: {
    readonly activation: "counterfactual" | "sponsored";
    readonly sponsorship?: {
      readonly policyId: string;
      readonly policyHash: Hex;
      readonly maxCostWei: string;
      readonly maxFactoryDataBytes: number;
      readonly maxActivationsPerPrincipal: number;
      readonly windowSeconds: number;
      readonly privateSubmission: true;
      readonly publicFallback: "disabled" | "explicit-rejection";
    };
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
  if (record.schemaVersion !== 2) throw new Error("deployment profile schema is unsupported");
  if (!Number.isSafeInteger(record.chainId) || Number(record.chainId) <= 0) throw new Error("deployment chain is invalid");
  for (const field of ["entryPoint", "factory", "appRegistry", "implementation", "validator", "policyHook"] as const) {
    if (!address(record[field])) throw new Error(`deployment ${field} is invalid`);
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(record.proxyCreationCode))) throw new Error("deployment proxy creation code is invalid");
  if (record.recoveryModule !== undefined && !address(record.recoveryModule)) throw new Error("deployment recovery module is invalid");
  if (record.recoveryIntentBoard !== undefined && !address(record.recoveryIntentBoard)) throw new Error("deployment recovery intent board is invalid");
  if (record.onboardingPaymaster !== undefined && !address(record.onboardingPaymaster)) throw new Error("deployment onboarding paymaster is invalid");
  const runtimeCodeHashes = parseRuntimeCodeHashes(record.runtimeCodeHashes);
  const verifiers = parseGuardianVerifiers(record.guardianVerifiers);
  requirePair("recoveryModule", record.recoveryModule, runtimeCodeHashes.recoveryModule);
  requirePair("recoveryIntentBoard", record.recoveryIntentBoard, runtimeCodeHashes.recoveryIntentBoard);
  requirePair("onboardingPaymaster", record.onboardingPaymaster, runtimeCodeHashes.onboardingPaymaster);
  requirePair("ecdsa guardian verifier", verifiers?.ecdsa, runtimeCodeHashes.ecdsaGuardianVerifier);
  requirePair("p256 guardian verifier", verifiers?.p256, runtimeCodeHashes.p256GuardianVerifier);
  requirePair("erc1271 guardian verifier", verifiers?.erc1271, runtimeCodeHashes.erc1271GuardianVerifier);
  const recoveryValidatorProvisioner = parseRecoveryValidatorProvisioner(record.recoveryValidatorProvisioner);
  const onboarding = parseOnboarding(record.onboarding);
  if (onboarding?.activation === "sponsored" && record.onboardingPaymaster === undefined) {
    throw new Error("sponsored onboarding requires the onboarding paymaster");
  }
  return Object.freeze({
    schemaVersion: 2,
    chainId: Number(record.chainId),
    entryPoint: record.entryPoint as Address,
    factory: record.factory as Address,
    appRegistry: record.appRegistry as Address,
    implementation: record.implementation as Address,
    validator: record.validator as Address,
    policyHook: record.policyHook as Address,
    proxyCreationCode: record.proxyCreationCode as Hex,
    runtimeCodeHashes,
    ...(record.recoveryModule === undefined ? {} : { recoveryModule: record.recoveryModule as Address }),
    ...(record.recoveryIntentBoard === undefined ? {} : { recoveryIntentBoard: record.recoveryIntentBoard as Address }),
    ...(record.onboardingPaymaster === undefined ? {} : { onboardingPaymaster: record.onboardingPaymaster as Address }),
    ...(verifiers ? { guardianVerifiers: verifiers } : {}),
    ...(recoveryValidatorProvisioner ? { recoveryValidatorProvisioner } : {}),
    ...(onboarding ? { onboarding } : {})
  });
}

function parseOnboarding(value: unknown): WalletDeployment["onboarding"] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("deployment onboarding policy is invalid");
  const record = value as Record<string, unknown>;
  if (record.activation !== "counterfactual" && record.activation !== "sponsored") throw new Error("deployment onboarding activation mode is invalid");
  if (record.activation === "counterfactual") {
    if (record.sponsorship !== undefined) throw new Error("counterfactual onboarding cannot advertise sponsorship");
    return Object.freeze({ activation: "counterfactual" });
  }
  if (!record.sponsorship || typeof record.sponsorship !== "object" || Array.isArray(record.sponsorship)) {
    throw new Error("sponsored onboarding policy is required");
  }
  const policy = record.sponsorship as Record<string, unknown>;
  if (typeof policy.policyId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(policy.policyId)) throw new Error("sponsorship policy id is invalid");
  if (!bytes32(policy.policyHash)) throw new Error("sponsorship policy hash is invalid");
  if (typeof policy.maxCostWei !== "string" || !/^[1-9][0-9]{0,77}$/u.test(policy.maxCostWei)) throw new Error("sponsorship max cost is invalid");
  for (const field of ["maxFactoryDataBytes", "maxActivationsPerPrincipal", "windowSeconds"] as const) {
    if (!Number.isSafeInteger(policy[field]) || Number(policy[field]) <= 0) throw new Error(`sponsorship ${field} is invalid`);
  }
  if (Number(policy.maxFactoryDataBytes) > 65_536 || Number(policy.maxActivationsPerPrincipal) > 1_000 || Number(policy.windowSeconds) > 31_536_000) {
    throw new Error("sponsorship policy limit exceeds the supported bound");
  }
  if (policy.privateSubmission !== true) throw new Error("sponsored onboarding must use private submission");
  if (policy.publicFallback !== "disabled" && policy.publicFallback !== "explicit-rejection") throw new Error("sponsorship public fallback policy is invalid");
  return Object.freeze({
    activation: "sponsored",
    sponsorship: Object.freeze({
      policyId: policy.policyId,
      policyHash: policy.policyHash as Hex,
      maxCostWei: policy.maxCostWei,
      maxFactoryDataBytes: Number(policy.maxFactoryDataBytes),
      maxActivationsPerPrincipal: Number(policy.maxActivationsPerPrincipal),
      windowSeconds: Number(policy.windowSeconds),
      privateSubmission: true,
      publicFallback: policy.publicFallback
    })
  });
}

function parseRuntimeCodeHashes(value: unknown): WalletDeployment["runtimeCodeHashes"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment runtime code hashes are required");
  const record = value as Record<string, unknown>;
  const required = ["entryPoint", "factory", "appRegistry", "implementation", "validator", "policyHook"] as const;
  for (const field of required) if (!bytes32(record[field])) throw new Error(`deployment ${field} runtime code hash is invalid`);
  const optional = ["recoveryModule", "recoveryIntentBoard", "onboardingPaymaster", "ecdsaGuardianVerifier", "p256GuardianVerifier", "erc1271GuardianVerifier"] as const;
  for (const field of optional) if (record[field] !== undefined && !bytes32(record[field])) throw new Error(`deployment ${field} runtime code hash is invalid`);
  return Object.freeze({
    entryPoint: record.entryPoint as Hex,
    factory: record.factory as Hex,
    appRegistry: record.appRegistry as Hex,
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
  const hasFallback = String(record.fallbackVerifier).toLowerCase() !== "0x0000000000000000000000000000000000000000";
  if (hasFallback && !bytes32(record.fallbackVerifierRuntimeCodeHash)) throw new Error("deployment recovery validator fallback verifier code hash is invalid");
  if (!hasFallback && record.fallbackVerifierRuntimeCodeHash !== undefined) throw new Error("deployment recovery validator has no fallback verifier to hash");
  return Object.freeze({
    address: record.address as Address,
    runtimeCodeHash: record.runtimeCodeHash as Hex,
    validatorRuntimeCodeHash: record.validatorRuntimeCodeHash as Hex,
    fallbackVerifier: record.fallbackVerifier as Address,
    ...(hasFallback ? { fallbackVerifierRuntimeCodeHash: record.fallbackVerifierRuntimeCodeHash as Hex } : {})
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
function requirePair(label: string, addressValue: unknown, hashValue: unknown): void {
  if (addressValue !== undefined && hashValue === undefined) throw new Error(`deployment ${label} runtime code hash is required`);
  if (addressValue === undefined && hashValue !== undefined) throw new Error(`deployment ${label} address is required`);
}
