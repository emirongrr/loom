/**
 * Where a guardian change is, when one is being made.
 *
 * The four steps describe making a change -- choose, review, wait out the
 * contract delay, then invite the people you just committed. They do not
 * describe the screen, which is a place you come back to in order to add or
 * remove someone. Someone looking at a settled set is not partway through
 * anything, and an indicator that insists otherwise is worse than none: it is
 * still read as if it could say where you are.
 *
 * So this reports `null` when nothing is in flight, and the step itself when
 * something is. Two earlier versions of this got it wrong in opposite
 * directions -- one lit "choose" and "invite" at the same time, the next
 * declared a settled account to be at "invite" forever.
 */
export type GuardianStep = 1 | 2 | 3 | 4;

export interface GuardianStepView {
  /** The step in progress, or null when the set is settled. */
  readonly current: GuardianStep | null;
  /** Steps already behind the reader, marked done rather than left pending. */
  readonly done: readonly GuardianStep[];
  /** True while a change is being made, which is when the steps are shown. */
  readonly changing: boolean;
}

export function guardianSetupStep(input: {
  /** A committed change is waiting out the configuration delay. */
  readonly pending: boolean;
  readonly stage: "list" | "review";
  /** The draft differs from what the chain holds. */
  readonly dirty: boolean;
  /** The account has no guardians at all yet. */
  readonly hasGuardians: boolean;
  /** A change finished recently and its guardians still need inviting. */
  readonly awaitingInvitations: boolean;
}): GuardianStepView {
  const current = currentStep(input);
  return Object.freeze({
    current,
    done: Object.freeze(current === null ? [] : ([1, 2, 3, 4] as const).filter(step => step < current)),
    changing: current !== null
  });
}

function currentStep(input: {
  readonly pending: boolean;
  readonly stage: "list" | "review";
  readonly dirty: boolean;
  readonly hasGuardians: boolean;
  readonly awaitingInvitations: boolean;
}): GuardianStep | null {
  if (input.pending) return 3;
  if (input.stage === "review") return 2;
  if (input.awaitingInvitations) return 4;
  // Setting up for the first time is a journey, so the steps lead. Editing an
  // existing set is not, and they only appear once there is a change to carry
  // through them.
  if (input.dirty || !input.hasGuardians) return 1;
  return null;
}
