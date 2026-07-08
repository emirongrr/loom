import type { MetadataBudget } from "@loom/privacy";

import { blockedGate } from "../platform/errors";
import type { FlowResult, MobileWalletConfiguration, PrivateSendDraft } from "../types/wallet";

export interface PrivateSendReadiness {
  readonly disabled: false;
  readonly protocol: "railgun";
  readonly metadataBudget: MetadataBudget;
}

export async function preparePrivateSend(input: {
  config: MobileWalletConfiguration;
  draft: PrivateSendDraft;
}): Promise<FlowResult<PrivateSendReadiness>> {
  if (!input.config.privacy.railgunProfile || input.config.privacy.releaseGate.status !== "passed") {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "privacy.railgun.disabled",
          title: "Privacy transfer not production-enabled",
          summary:
            "Private send is disabled until Railgun adapter evidence, local scan rehearsal, and failure-mode tests pass.",
          evidence: input.config.privacy.releaseGate.evidence
        })
      ]
    };
  }

  const context = input.config.privacy.context;
  if (!context) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "privacy.context.missing",
          title: "Privacy context missing",
          summary: "A scoped privacy context is required before building a private operation."
        })
      ]
    };
  }

  // The adapter's metadata budget is the honest disclosure of what a private
  // transfer still reveals (relayer, indexer, timing, ...). The draft must
  // carry an acknowledged copy of that budget: a send that has not surfaced
  // the budget to the user is blocked, not silently allowed.
  const budget = await input.config.privacy.railgunProfile.metadataBudget(context);
  const acknowledged = input.draft.metadataBudget;

  if (!acknowledged || acknowledged.protocol !== budget.protocol || acknowledged.chainId !== budget.chainId) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "privacy.metadata-budget.unacknowledged",
          title: "Metadata budget not acknowledged",
          summary:
            "The private send draft must acknowledge the adapter's metadata budget for this protocol and chain before an operation is built."
        })
      ]
    };
  }

  const missingSurfaces = budget.items
    .filter(item => item.required && !acknowledged.items.some(ack => ack.surface === item.surface))
    .map(item => item.surface);

  if (missingSurfaces.length > 0) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "privacy.metadata-budget.incomplete",
          title: "Metadata budget acknowledgment incomplete",
          summary: `The draft does not acknowledge required metadata surfaces: ${missingSurfaces.join(", ")}.`
        })
      ]
    };
  }

  return {
    status: "ready",
    value: {
      disabled: false,
      protocol: "railgun",
      metadataBudget: budget
    }
  };
}
