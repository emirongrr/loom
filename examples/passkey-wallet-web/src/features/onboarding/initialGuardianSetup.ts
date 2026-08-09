import type { Address, Hex } from "@loom/core";
import type { GuardianSet } from "@loom/sdk/recovery";
import type { WalletDeployment } from "./accountLifecycle.ts";
import { planGuardianChange, withFreshSalts, type RosterEntry } from "../security/guardianPlan.ts";

export interface InitialGuardianSetup {
  readonly entries: readonly RosterEntry[];
  readonly set: GuardianSet;
}

/** Revalidate guardian verifier authority immediately before account derivation. */
export async function prepareInitialGuardianSetup(input: {
  readonly entries: readonly RosterEntry[];
  readonly threshold: number;
  readonly deployment: WalletDeployment;
  readonly readVerifierCodeHash: (verifier: Address) => Promise<Hex>;
  readonly randomBytes?: (length: number) => Uint8Array;
}): Promise<InitialGuardianSetup> {
  if (!input.deployment.recoveryModule) throw new Error("Protected creation requires a recovery module in this deployment.");
  if (!input.deployment.guardianVerifiers) throw new Error("This deployment publishes no guardian verifiers.");
  const checked = new Map<string, Hex>();
  for (const entry of input.entries) {
    const expected = verifierFor(entry, input.deployment);
    if (!expected || expected.toLowerCase() !== entry.descriptor.verifier.toLowerCase()) throw new Error(`This guardian does not use the deployment's ${entry.descriptor.kind.toUpperCase()} guardian verifier.`);
    const key = expected.toLowerCase();
    const runtimeHash = checked.get(key) ?? await input.readVerifierCodeHash(expected);
    checked.set(key, runtimeHash);
    if (runtimeHash.toLowerCase() !== entry.descriptor.verifierCodeHash.toLowerCase()) throw new Error("A guardian verifier's runtime code changed after it was selected.");
  }
  const entries = withFreshSalts(input.entries, input.randomBytes);
  const plan = planGuardianChange({ current: [], next: entries, threshold: input.threshold });
  return Object.freeze({ entries, set: plan.set });
}

function verifierFor(entry: RosterEntry, deployment: WalletDeployment): Address | undefined {
  switch (entry.descriptor.kind) {
    case "ecdsa": return deployment.guardianVerifiers?.ecdsa;
    case "erc1271": return deployment.guardianVerifiers?.erc1271;
    case "p256": return deployment.guardianVerifiers?.p256;
  }
}
