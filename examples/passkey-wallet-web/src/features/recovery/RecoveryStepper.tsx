import { ORDER, recoveryViewStage, type RecoveryViewStage } from "./recoveryProgress";

export { recoveryViewStage, type RecoveryViewStage };

export function RecoveryStepper({ stage }: { stage: RecoveryViewStage }) {
  const steps: readonly [RecoveryViewStage, string][] = [
    ["account-verification", "Verify account"],
    ["validator-provisioning", "New passkey"],
    ["guardian-approvals", "Guardian approvals"],
    ["delay-execution", "Wait and execute"]
  ];
  const current = ORDER.indexOf(stage);
  return <ol className="stepper" aria-label="Recovery stages">
    {steps.map(([id, label], index) => <li
      key={id}
      // Steps already passed are marked done rather than left looking pending,
      // so the reader can see how far they are rather than only where they are.
      className={index < current ? "done" : stage === id ? "active" : ""}
      aria-current={stage === id ? "step" : undefined}
    ><span>{index + 1}</span>{label}</li>)}
  </ol>;
}
