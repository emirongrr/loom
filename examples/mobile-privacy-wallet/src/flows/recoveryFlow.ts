import { buildProgressiveGuardianSetupPlan, type GuardianOnboardingEvidence } from "@loom/guardian";

import { blockedGate } from "../platform/errors";
import type { FlowResult, Hex } from "../types/wallet";

export function prepareGuardianSetup(input: {
  account: Hex;
  chainId: number;
  recoveryConfigured: boolean;
  evidence?: GuardianOnboardingEvidence;
}): FlowResult<ReturnType<typeof buildProgressiveGuardianSetupPlan>> {
  if (!input.evidence) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "guardian.evidence.missing",
          title: "Guardian ceremony evidence missing",
          summary:
            "Guardian setup requires proof-of-possession, encrypted backup, usability proof, and privacy review evidence."
        })
      ]
    };
  }

  return {
    status: "ready",
    value: buildProgressiveGuardianSetupPlan({
      account: input.account,
      chainId: input.chainId,
      currentRecoveryConfigured: input.recoveryConfigured,
      evidence: input.evidence
    })
  };
}

