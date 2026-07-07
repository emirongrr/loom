import type {
  HeliosNetworkKind,
  Hex,
  MobileWalletConfiguration,
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

export function readEnvironmentConfiguration(): MobileWalletConfiguration {
  const chainId = optionalNumber(process.env.EXPO_PUBLIC_LOOM_CHAIN_ID) ?? 1;
  const l1ChainId = optionalNumber(process.env.EXPO_PUBLIC_LOOM_L1_CHAIN_ID) ?? 1;

  return {
    environment: walletEnvironment(process.env.LOOM_WALLET_ENV),
    rpId: process.env.EXPO_PUBLIC_LOOM_RP_ID ?? "localhost",
    origin: process.env.EXPO_PUBLIC_LOOM_ORIGIN ?? "app://loom-mobile-privacy-wallet",
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
