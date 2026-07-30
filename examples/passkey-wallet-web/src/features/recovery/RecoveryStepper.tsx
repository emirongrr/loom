import type { RecoverySessionStage } from "./recoverySession";

export type RecoveryViewStage = "account-verification" | "validator-provisioning" | "guardian-approvals" | "delay-execution";

export function recoveryViewStage(input: { showingPasskey?: boolean; sessionStage?: RecoverySessionStage }): RecoveryViewStage {
  if (!input.sessionStage) return input.showingPasskey ? "validator-provisioning" : "account-verification";
  return ["request-created", "collecting", "ready-to-propose"].includes(input.sessionStage)
    ? "guardian-approvals"
    : "delay-execution";
}

export function RecoveryStepper({ stage }: { stage: RecoveryViewStage }) {
  const steps: readonly [RecoveryViewStage, string][] = [
    ["account-verification", "Verify account"],
    ["validator-provisioning", "New passkey"],
    ["guardian-approvals", "Guardian approvals"],
    ["delay-execution", "Wait and execute"]
  ];
  return <ol className="stepper" aria-label="Recovery stages">
    {steps.map(([id, label], index) => <li key={id} className={stage === id ? "active" : ""} aria-current={stage === id ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}
  </ol>;
}
