import type { WalletLabScenario } from "./model.js";

export function defineWalletLabScenario<const T extends WalletLabScenario>(scenario: T): Readonly<T> {
  if (scenario.schema !== "loom.wallet-lab.scenario" || scenario.version !== 1) {
    throw new Error("wallet lab scenario must use schema version 1");
  }
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(scenario.id)) {
    throw new Error("wallet lab scenario id is invalid");
  }
  if (scenario.seed.length < 8) throw new Error("wallet lab scenario seed is too short");
  if (scenario.actions.length === 0) throw new Error("wallet lab scenario needs at least one action");
  const ids = new Set<string>();
  for (const action of scenario.actions) {
    if (ids.has(action.id)) throw new Error(`duplicate wallet lab action id: ${action.id}`);
    ids.add(action.id);
    if (BigInt(action.valueWei) < 0n) throw new Error(`native transfer ${action.id} has a negative value`);
  }
  return Object.freeze(scenario);
}

export const nativeTransferScenario = defineWalletLabScenario({
  schema: "loom.wallet-lab.scenario",
  version: 1,
  id: "passkey-native-transfer.v1",
  title: "Passkey-signed ERC-4337 native transfer",
  seed: "loom-wallet-lab-phase-1",
  initialSnapshot: "clean-devnet",
  actions: [
    {
      id: "transfer-1",
      kind: "native-transfer",
      target: "devnet-target",
      valueWei: "123",
      targetCall: { function: "setValue", value: "4242" }
    }
  ],
  expectedInvariants: [
    "sdk-entrypoint-userop-hash-match",
    "receipt-provenance-match",
    "native-balance-delta-match",
    "target-state-transition-match",
    "finality-not-inferred-from-simulation"
  ]
});
