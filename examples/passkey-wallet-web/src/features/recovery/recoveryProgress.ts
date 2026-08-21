import type { RecoverySessionStage } from "./recoverySession";

export type RecoveryViewStage = "account-verification" | "validator-provisioning" | "guardian-approvals" | "delay-execution";

export const ORDER: readonly RecoveryViewStage[] = [
  "account-verification",
  "validator-provisioning",
  "guardian-approvals",
  "delay-execution"
];

/**
 * The furthest point this recovery has actually reached.
 *
 * The stepper used to read one local flag -- whether the passkey block was on
 * screen -- so an account with a proposal recorded on chain, its delay already
 * running, still showed "New passkey" as the current step. The reader was told
 * to do something they had finished days earlier, next to a panel counting down
 * to execution.
 *
 * Progress is a fact about the account, not about which panel is open, so it is
 * taken from the strongest evidence available and never moves backwards: a
 * published validator outranks an open passkey form, a session outranks a
 * publication, and a pending recovery on chain outranks all of them.
 */
export function recoveryViewStage(input: {
  readonly showingPasskey?: boolean;
  readonly sessionStage?: RecoverySessionStage;
  /** A validator is published for this account, so the passkey step is done. */
  readonly validatorPublished?: boolean;
  /** The manager holds a proposal, so the guardians have already approved. */
  readonly pendingOnChain?: boolean;
}): RecoveryViewStage {
  const reached: RecoveryViewStage[] = ["account-verification"];
  if (input.showingPasskey) reached.push("validator-provisioning");
  if (input.validatorPublished) reached.push("guardian-approvals");
  if (input.sessionStage) {
    reached.push(["request-created", "collecting", "ready-to-propose"].includes(input.sessionStage)
      ? "guardian-approvals"
      : "delay-execution");
  }
  // A recovery the manager already holds is past approval by construction: it
  // refuses to record one without the guardian threshold.
  if (input.pendingOnChain) reached.push("delay-execution");
  return reached.reduce((furthest, stage) => (ORDER.indexOf(stage) > ORDER.indexOf(furthest) ? stage : furthest));
}
