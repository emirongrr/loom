import type { RecoverySessionStage } from "./recoverySession";

/**
 * What a recovery session shows, and what the person can do about it.
 *
 * These decisions were spread through a single JSX expression of some eight
 * thousand characters, with `canCollect` re-tested in four places and the
 * threshold check inlined beside it. Reading that told you what the screen
 * contained; it did not tell you what it showed in any given state, which is
 * the question anyone changing it actually has.
 *
 * Pulled out here so the answer can be read, and tested, without a browser.
 * The rendering follows this rather than deciding for itself.
 */
export type RecoveryPanel =
  | "collect-from-chain"
  | "import-response"
  | "threshold-reached"
  | "proposal-receipt"
  | "check-readiness"
  | "executable"
  | "execution-receipt"
  | "send-to-guardians";

/** The one thing the screen is asking for, if it is asking for anything. */
export type RecoveryPrimaryAction =
  | "collect-approvals"
  | "propose"
  | "wait"
  | "execute"
  | "save-recovered-wallet"
  | "none";

export interface RecoverySessionView {
  readonly stage: RecoverySessionStage;
  readonly panels: readonly RecoveryPanel[];
  readonly primary: RecoveryPrimaryAction;
  readonly seatsFilled: number;
  readonly threshold: number;
  readonly thresholdReached: boolean;
  /** True while responses can still be added to this session. */
  readonly collecting: boolean;
}

export function recoverySessionView(input: {
  readonly stage: RecoverySessionStage;
  readonly seatsFilled: number;
  readonly threshold: number;
  readonly hasProposalTransaction: boolean;
  readonly hasExecutionTransaction: boolean;
}): RecoverySessionView {
  const threshold = Math.max(1, Math.trunc(input.threshold));
  const seatsFilled = Math.max(0, Math.trunc(input.seatsFilled));
  const collecting = input.stage === "request-created" || input.stage === "collecting";
  const thresholdReached = seatsFilled >= threshold;

  const panels: RecoveryPanel[] = [];
  if (collecting) panels.push("collect-from-chain", "import-response");
  // Offered once the seats are filled, whether the session recorded the last
  // response itself or read it from the board.
  if (input.stage === "ready-to-propose" || (collecting && thresholdReached)) panels.push("threshold-reached");
  if (input.hasProposalTransaction) panels.push("proposal-receipt");
  if (input.stage === "delay-active") panels.push("check-readiness");
  if (input.stage === "ready-to-execute") panels.push("executable");
  if (input.hasExecutionTransaction) panels.push("execution-receipt");
  // Last, and only while it can still do anything: handing the request out
  // after the threshold is met asks guardians for approvals nobody needs.
  if (collecting) panels.push("send-to-guardians");

  return Object.freeze({
    stage: input.stage,
    panels: Object.freeze(panels),
    primary: primaryAction({ stage: input.stage, collecting, thresholdReached, hasExecutionTransaction: input.hasExecutionTransaction }),
    seatsFilled,
    threshold,
    thresholdReached,
    collecting
  });
}

function primaryAction(input: {
  readonly stage: RecoverySessionStage;
  readonly collecting: boolean;
  readonly thresholdReached: boolean;
  readonly hasExecutionTransaction: boolean;
}): RecoveryPrimaryAction {
  if (input.hasExecutionTransaction) return "save-recovered-wallet";
  switch (input.stage) {
    case "ready-to-execute": return "execute";
    case "delay-active": return "wait";
    case "ready-to-propose": return "propose";
    case "request-created":
    case "collecting": return input.thresholdReached ? "propose" : "collect-approvals";
    // A session that ended -- completed, cancelled, expired, or blocked by
    // something outside it -- asks for nothing. Offering an action there would
    // be offering one the chain has already refused.
    default: return "none";
  }
}

/** How many more guardians have to answer. Never negative. */
export function seatsRemaining(view: RecoverySessionView): number {
  return Math.max(0, view.threshold - view.seatsFilled);
}
