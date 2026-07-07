import { blockedGate } from "../platform/errors";
import type { FlowResult, MobileWalletConfiguration, PrivateSendDraft } from "../types/wallet";

export async function preparePrivateSend(input: {
  config: MobileWalletConfiguration;
  draft: PrivateSendDraft;
}): Promise<FlowResult<{ readonly disabled: false; readonly protocol: "railgun" }>> {
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

  await input.config.privacy.railgunProfile.metadataBudget(context);

  return {
    status: "ready",
    value: {
      disabled: false,
      protocol: "railgun"
    }
  };
}

