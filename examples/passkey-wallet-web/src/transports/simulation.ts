import type { Address, Hex } from "@loom/core";
import type { SimulationResult } from "../types";

export interface SimulationAdapter {
  simulate(input: { account: Address; calls: readonly { target: Address; value: bigint; data: Hex }[] }): Promise<SimulationResult>;
}

export function createRpcSimulationAdapter(options: {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
  executionCaller: Address;
  blockTag?: string;
  encodeAccountCall(input: { account: Address; calls: readonly { target: Address; value: bigint; data: Hex }[] }): Hex;
}): SimulationAdapter {
  return Object.freeze({
    async simulate({ account, calls }: { account: Address; calls: readonly { target: Address; value: bigint; data: Hex }[] }): Promise<SimulationResult> {
      try {
        if (calls.length === 0) return { status: "unavailable", summary: "There are no calls to simulate." };
        const data = options.encodeAccountCall({ account, calls });
        await options.request("eth_call", [{ from: options.executionCaller, to: account, data }, options.blockTag ?? "latest"]);
        return { status: "verified", summary: `The complete ${calls.length}-call account operation executed successfully in one atomic RPC simulation.` };
      } catch (error) {
        return { status: "failed", summary: error instanceof Error ? error.message : "RPC simulation failed" };
      }
    }
  });
}
