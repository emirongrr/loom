import {
  createRpcStateTransport,
  unverified,
  type LoomStateReadTransport,
  type UnverifiedState
} from "@loom/sdk";

import { blockedGate } from "../platform/errors";
import type {
  FlowResult,
  MobileWalletConfiguration,
  ReleaseGate
} from "../types/wallet";
import {
  createHeliosVerifiedStateRuntime,
  heliosReadiness,
  type HeliosVerifiedStateRuntime
} from "./helios";

export type MobileStateTransportRuntime =
  | HeliosVerifiedStateRuntime
  | {
      readonly stateTransport: LoomStateReadTransport;
      readonly verification: UnverifiedState<"explicit-rpc">;
      shutdown(): Promise<void>;
    };

export async function createMobileStateTransport(
  config: MobileWalletConfiguration
): Promise<FlowResult<MobileStateTransportRuntime>> {
  if (config.stateTransport) {
    return {
      status: "ready",
      value: {
        stateTransport: config.stateTransport,
        verification: unverified("caller supplied an external state transport", "explicit-rpc", {
          source: "external-state-transport"
        }),
        async shutdown() {}
      }
    };
  }

  if (config.verifiedState.mode === "helios") {
    return createHeliosVerifiedStateRuntime(config.verifiedState.helios);
  }

  if (config.verifiedState.mode === "rpc") {
    if (!config.network.rpcUrl) {
      return blockedStateReads("verified-state.rpc.config", "Explicit RPC state reads are not configured.");
    }
    return {
      status: "ready",
      value: {
        stateTransport: createRpcStateTransport({
          endpoint: config.network.rpcUrl,
          fetch: config.transportFetch
        }),
        verification: unverified("plain RPC reads are not light-client verified", "explicit-rpc", {
          source: "user-supplied-rpc",
          assumptions: ["RPC endpoint is user supplied and replaceable but not a verification root"]
        }),
        async shutdown() {}
      },
      gates: [
        blockedGate({
          id: "verified-state.rpc.unverified",
          title: "State reads are unverified",
          summary: "Plain RPC mode is an explicit fallback and must not be presented as verified wallet state."
        })
      ]
    };
  }

  return blockedStateReads("verified-state.disabled", "State reads are disabled by configuration.");
}

export function stateReadinessGate(config: MobileWalletConfiguration): ReleaseGate {
  if (config.verifiedState.mode === "helios") {
    const readiness = heliosReadiness(config.verifiedState.helios);
    if (readiness.status === "ready") {
      return {
        id: "verified-state.helios.config",
        title: "Helios verified reads configured",
        status: "passed",
        summary: "Execution RPC, consensus RPC, and checkpoint are configured for Helios verified reads."
      };
    }
    return firstGate(readiness.gates);
  }

  if (config.verifiedState.mode === "rpc" && config.network.rpcUrl) {
    return {
      id: "verified-state.rpc.config",
      title: "Explicit RPC fallback configured",
      status: "blocked",
      summary: "State reads use a user supplied RPC fallback and are not light-client verified."
    };
  }

  return {
    id: "verified-state.unavailable",
    title: "Verified state reads unavailable",
    status: "not-configured",
    summary: "Configure Helios before treating balances, nonces, recovery, or vault state as verified."
  };
}

function blockedStateReads(id: string, summary: string): FlowResult<MobileStateTransportRuntime> {
  return {
    status: "blocked",
    gates: [
      blockedGate({
        id,
        title: "State reads unavailable",
        summary
      })
    ]
  };
}

function firstGate(gates: readonly ReleaseGate[]): ReleaseGate {
  const gate = gates[0];
  if (gate === undefined) {
    return blockedGate({
      id: "verified-state.helios.unknown",
      title: "Helios verified reads are blocked",
      summary: "Helios readiness failed without a specific gate."
    });
  }
  return gate;
}
