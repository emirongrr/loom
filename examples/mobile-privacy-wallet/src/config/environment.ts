import type {
  HeliosNetworkKind,
  Hex,
  MobileWalletConfiguration,
  P256VerifierMode,
  ReleaseGate,
  VerifiedStateMode
} from "../types/wallet";
import { blockedGate } from "../platform/errors";

function optionalHex(value: string | undefined): Hex | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Expected address-like hex value, received ${value}`);
  }
  return value as Hex;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}

function verifiedStateMode(value: string | undefined): VerifiedStateMode {
  if (value === "helios" || value === "rpc" || value === "disabled") {
    return value;
  }
  return "helios";
}

function heliosNetworkKind(value: string | undefined): HeliosNetworkKind {
  if (value === "ethereum" || value === "opstack" || value === "linea") {
    return value;
  }
  return "ethereum";
}

function p256VerifierMode(value: string | undefined): P256VerifierMode {
  if (value === "native-precompile" || value === "fallback-contract") {
    return value;
  }
  return "not-configured";
}

// Missing critical values are NOT silently defaulted. chainId 0 and empty
// rpId/origin are unset sentinels that configurationReadiness() flags and the
// account/passkey flows refuse to proceed on. Defaulting a missing chainId to
// mainnet, or a missing passkey origin to localhost, would be exactly the kind
// of hidden assumption this wallet is built to avoid.
export function readEnvironmentConfiguration(): MobileWalletConfiguration {
  const chainId = optionalNumber(process.env.EXPO_PUBLIC_LOOM_CHAIN_ID) ?? 0;
  const l1ChainId = optionalNumber(process.env.EXPO_PUBLIC_LOOM_L1_CHAIN_ID) ?? 0;

  return {
    rpId: process.env.EXPO_PUBLIC_LOOM_RP_ID ?? "",
    origin: process.env.EXPO_PUBLIC_LOOM_ORIGIN ?? "",
    network: {
      chainId,
      l1ChainId,
      rpcUrl: process.env.EXPO_PUBLIC_LOOM_RPC_URL || undefined,
      bundlerUrl: process.env.EXPO_PUBLIC_LOOM_BUNDLER_URL || undefined,
      entryPoint: optionalHex(process.env.EXPO_PUBLIC_LOOM_ENTRYPOINT)
    },
    verifiedState: {
      mode: verifiedStateMode(process.env.EXPO_PUBLIC_LOOM_STATE_MODE),
      helios: {
        networkKind: heliosNetworkKind(process.env.EXPO_PUBLIC_LOOM_HELIOS_KIND),
        network: process.env.EXPO_PUBLIC_LOOM_HELIOS_NETWORK || "sepolia",
        executionRpc: process.env.EXPO_PUBLIC_LOOM_HELIOS_EXECUTION_RPC || undefined,
        consensusRpc: process.env.EXPO_PUBLIC_LOOM_HELIOS_CONSENSUS_RPC || undefined,
        checkpoint: process.env.EXPO_PUBLIC_LOOM_HELIOS_CHECKPOINT || undefined,
        verifiableApi: process.env.EXPO_PUBLIC_LOOM_HELIOS_VERIFIABLE_API || undefined
      }
    },
    deployment: {
      accountFactory: optionalHex(process.env.EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY),
      passkeyValidator: optionalHex(process.env.EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR),
      p256VerifierAddress: optionalHex(process.env.EXPO_PUBLIC_LOOM_P256_VERIFIER),
      p256VerifierMode: p256VerifierMode(process.env.EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE),
      deploymentManifestPath: process.env.EXPO_PUBLIC_LOOM_DEPLOYMENT_MANIFEST || undefined
    },
    privacy: {
      releaseGate: blockedGate({
        id: "privacy.railgun.profile",
        title: "Railgun privacy evidence missing",
        summary: "Private transfer remains disabled until a passing privacy adapter profile is configured.",
        evidence: process.env.EXPO_PUBLIC_LOOM_PRIVACY_PROFILE_PATH || undefined
      })
    }
  };
}

/**
 * The critical configuration checks, as data.
 *
 * The count used to be a hand-written `9` sitting beside the function, and
 * HomeScreen renders it as "N/9 configured" -- so a tenth check added without
 * touching the constant would have shown a full bar while a gate was still
 * blocked. The one number a user reads to decide whether the wallet is ready
 * should not be maintained separately from the checks it counts.
 */
const CONFIGURATION_CHECKS: readonly {
  readonly id: string;
  readonly summary: string;
  missing(config: MobileWalletConfiguration): boolean;
}[] = Object.freeze([
  {
    id: "config.chainId",
    summary: "EXPO_PUBLIC_LOOM_CHAIN_ID is not set; the wallet will not assume a chain.",
    missing: config => config.network.chainId <= 0
  },
  {
    id: "config.l1ChainId",
    summary: "EXPO_PUBLIC_LOOM_L1_CHAIN_ID is not set; recovery/keystore roots need an explicit L1.",
    missing: config => config.network.l1ChainId <= 0
  },
  {
    id: "config.rpId",
    summary: "EXPO_PUBLIC_LOOM_RP_ID is not set; passkeys must bind to an explicit relying-party id.",
    missing: config => config.rpId.length === 0
  },
  {
    id: "config.origin",
    summary: "EXPO_PUBLIC_LOOM_ORIGIN is not set; passkeys must bind to an explicit origin.",
    missing: config => config.origin.length === 0
  },
  {
    id: "config.entryPoint",
    summary: "EXPO_PUBLIC_LOOM_ENTRYPOINT is not set; UserOperations cannot be submitted.",
    missing: config => !config.network.entryPoint
  },
  {
    id: "config.bundler",
    summary: "EXPO_PUBLIC_LOOM_BUNDLER_URL is not set; there is no submission transport.",
    missing: config => !config.network.bundlerUrl
  },
  {
    id: "config.factory",
    summary: "EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY is not set; accounts cannot be deployed.",
    missing: config => !config.deployment.accountFactory
  },
  {
    id: "config.passkeyValidator",
    summary: "EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR is not set; passkey accounts cannot be created.",
    missing: config => !config.deployment.passkeyValidator
  },
  {
    id: "config.p256Mode",
    summary: "EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE is not set; do not deploy passkey accounts.",
    missing: config => config.deployment.p256VerifierMode === "not-configured"
  }
]);

/** Total number of critical checks performed by configurationReadiness. */
export const CONFIGURATION_CHECK_COUNT = CONFIGURATION_CHECKS.length;

/**
 * Returns a blocked gate for every critical configuration value that is missing
 * or left at its unset sentinel. The account and passkey flows must consult this
 * before creating an account, and the UI surfaces it so a half-configured build
 * fails visibly instead of silently assuming mainnet or a localhost origin.
 */
export function configurationReadiness(config: MobileWalletConfiguration): readonly ReleaseGate[] {
  return CONFIGURATION_CHECKS.filter(check => check.missing(config)).map(check => ({
    id: check.id,
    title: "Configuration incomplete",
    status: "not-configured" as const,
    summary: check.summary
  }));
}
