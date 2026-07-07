import type { Config as HeliosConfig, Network, NetworkKind } from "@a16z/helios";
import {
  createEip1193StateTransport,
  type Eip1193Provider,
  type LoomStateReadTransport,
  type VerificationProfile
} from "@loom/sdk";

import { blockedGate, MobileWalletConfigurationError } from "../platform/errors";
import type {
  FlowResult,
  HeliosStateConfiguration,
  ReleaseGate
} from "../types/wallet";

export interface HeliosVerifiedStateRuntime {
  readonly stateTransport: LoomStateReadTransport;
  readonly verification: VerificationProfile;
  shutdown(): Promise<void>;
}

const HELIOS_REQUIRED_FIELDS = Object.freeze([
  "executionRpc",
  "consensusRpc",
  "checkpoint"
]);

export function heliosReadiness(input: HeliosStateConfiguration): FlowResult<HeliosStateConfiguration> {
  const missing = HELIOS_REQUIRED_FIELDS.filter(field => {
    const value = input[field as keyof HeliosStateConfiguration];
    return typeof value !== "string" || value.length === 0;
  });

  if (missing.length > 0) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "verified-state.helios.config",
          title: "Helios verified reads are not configured",
          summary: `Missing ${missing.join(", ")}. State reads remain disabled or explicitly unverified.`
        })
      ]
    };
  }

  return {
    status: "ready",
    value: input
  };
}

export async function createHeliosVerifiedStateRuntime(
  input: HeliosStateConfiguration
): Promise<FlowResult<HeliosVerifiedStateRuntime>> {
  const readiness = heliosReadiness(input);
  if (readiness.status === "blocked") {
    return {
      status: "blocked",
      gates: readiness.gates
    };
  }

  const config = toHeliosConfig(readiness.value);
  const { createHeliosProvider } = await import("@a16z/helios");
  const provider = await createHeliosProvider(config, input.networkKind as NetworkKind);
  await provider.waitSynced();

  const verification: VerificationProfile = {
    status: "verified",
    source: "helios",
    blockTag: "safe",
    assumptions: [
      "weak-subjectivity checkpoint supplied by the user or integrator",
      "execution RPC is untrusted data transport and must support required proofs",
      "consensus RPC is user supplied and replaceable",
      "mobile WASM/light-client runtime must be release-tested on target devices"
    ]
  };
  const stateTransport = createEip1193StateTransport({
    provider: provider as Eip1193Provider,
    verification
  });

  return {
    status: "ready",
    value: {
      stateTransport,
      verification,
      async shutdown() {
        await provider.shutdown();
      }
    },
    gates: [heliosEvidenceGate()]
  };
}

function toHeliosConfig(input: HeliosStateConfiguration): HeliosConfig {
  requireUrl(input.executionRpc, "Helios execution RPC");
  requireUrl(input.consensusRpc, "Helios consensus RPC");
  requireCheckpoint(input.checkpoint);
  if (input.verifiableApi !== undefined) {
    requireUrl(input.verifiableApi, "Helios verifiable API");
  }

  return {
    executionRpc: input.executionRpc,
    consensusRpc: input.consensusRpc,
    checkpoint: input.checkpoint,
    network: input.network as Network,
    verifiableApi: input.verifiableApi,
    dbType: "config"
  };
}

function requireUrl(value: string | undefined, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new MobileWalletConfigurationError(`${label} is required.`);
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new MobileWalletConfigurationError(`${label} must be https or localhost.`);
  }
}

function requireCheckpoint(value: string | undefined) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new MobileWalletConfigurationError("Helios checkpoint must be a 32-byte hex root.");
  }
}

function heliosEvidenceGate(): ReleaseGate {
  return blockedGate({
    id: "verified-state.helios.mobile-evidence",
    title: "Helios mobile evidence required",
    summary:
      "Verified reads are wired through Helios, but production release still requires physical iOS/Android sync evidence."
  });
}
