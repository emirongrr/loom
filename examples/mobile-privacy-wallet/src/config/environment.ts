import type {
  HeliosNetworkKind,
  Hex,
  MobileWalletConfiguration,
  P256VerifierMode,
  ReleaseGate,
  VerifiedStateMode,
  WalletEnvironment
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

function walletEnvironment(value: string | undefined): WalletEnvironment {
  if (value === "production" || value === "testnet" || value === "development") {
    return value;
  }
  return "development";
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
    environment: walletEnvironment(process.env.LOOM_WALLET_ENV),
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

/** Total number of critical checks performed by configurationReadiness. */
export const CONFIGURATION_CHECK_COUNT = 9;

/**
 * Returns a blocked gate for every critical configuration value that is missing
 * or left at its unset sentinel. The account and passkey flows must consult this
 * before creating an account, and the UI surfaces it so a half-configured build
 * fails visibly instead of silently assuming mainnet or a localhost origin.
 */
export function configurationReadiness(config: MobileWalletConfiguration): readonly ReleaseGate[] {
  const gates: ReleaseGate[] = [];
  const missing = (id: string, summary: string): void => {
    gates.push({ id, title: "Configuration incomplete", status: "not-configured", summary });
  };

  if (config.network.chainId <= 0) {
    missing("config.chainId", "EXPO_PUBLIC_LOOM_CHAIN_ID is not set; the wallet will not assume a chain.");
  }
  if (config.network.l1ChainId <= 0) {
    missing("config.l1ChainId", "EXPO_PUBLIC_LOOM_L1_CHAIN_ID is not set; recovery/keystore roots need an explicit L1.");
  }
  if (config.rpId.length === 0) {
    missing("config.rpId", "EXPO_PUBLIC_LOOM_RP_ID is not set; passkeys must bind to an explicit relying-party id.");
  }
  if (config.origin.length === 0) {
    missing("config.origin", "EXPO_PUBLIC_LOOM_ORIGIN is not set; passkeys must bind to an explicit origin.");
  }
  if (!config.network.entryPoint) {
    missing("config.entryPoint", "EXPO_PUBLIC_LOOM_ENTRYPOINT is not set; UserOperations cannot be submitted.");
  }
  if (!config.network.bundlerUrl) {
    missing("config.bundler", "EXPO_PUBLIC_LOOM_BUNDLER_URL is not set; there is no submission transport.");
  }
  if (!config.deployment.accountFactory) {
    missing("config.factory", "EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY is not set; accounts cannot be deployed.");
  }
  if (!config.deployment.passkeyValidator) {
    missing("config.passkeyValidator", "EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR is not set; passkey accounts cannot be created.");
  }
  if (config.deployment.p256VerifierMode === "not-configured") {
    missing("config.p256Mode", "EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE is not set; do not deploy passkey accounts.");
  }
  return gates;
}
