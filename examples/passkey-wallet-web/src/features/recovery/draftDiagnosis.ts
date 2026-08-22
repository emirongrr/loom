import { GuardianRecoveryError } from "@loom/sdk/recovery";

/**
 * Why a saved recovery draft could not be used, in terms a reader can act on.
 *
 * The restore loop used to swallow every failure. A device holding drafts that
 * would not open was therefore indistinguishable from a device holding none,
 * and the interface told the reader to buy another passkey -- gas spent to work
 * around a problem nobody had looked at.
 *
 * What is safe to show: these failures come from code-authored checks, and
 * every message in the closed set below is a literal from this repository. A
 * draft's contents -- its init data, passkey material, or anything derived from
 * them -- never reaches this module, and an unrecognised error contributes only
 * its constructor name.
 */
export type DraftFailureStage =
  /** The stored record would not decode, or failed its own integrity checks. */
  | "decode"
  /** It decoded, but the validator address could not be derived from it. */
  | "derive"
  /** It decoded and derived, and named a different validator than it claimed. */
  | "mismatch";

export interface DraftFailure {
  readonly stage: DraftFailureStage;
  /** Draft label, so a reader can tell two drafts apart. Never its contents. */
  readonly label: string;
  readonly reason: string;
}

const STAGE_TEXT: Readonly<Record<DraftFailureStage, string>> = Object.freeze({
  decode: "could not be read",
  derive: "could not be checked against the chain",
  mismatch: "does not match the validator it names"
});

/**
 * Messages this build produces itself, and may therefore repeat verbatim.
 *
 * An allowlist rather than a filter: anything unrecognised is reported by its
 * error type alone, so a message that ever did carry data could not leak
 * through a check nobody updated.
 */
const KNOWN = [
  "recovery draft is invalid",
  "recovery draft format is invalid",
  "recovery draft identity is invalid",
  "recovery draft chain binding is invalid",
  "recovery draft metadata is invalid",
  "recovery draft key is invalid",
  "recovery draft preparation is invalid",
  "recovery draft passkey is invalid",
  "recovery draft init data hash is invalid",
  "recovery draft deployment is invalid",
  "draft key mismatch"
] as const;

export function describeDraftFailure(input: {
  readonly stage: DraftFailureStage;
  readonly label: string;
  readonly error?: unknown;
}): DraftFailure {
  return Object.freeze({
    stage: input.stage,
    label: input.label.slice(0, 80),
    reason: safeReason(input.error)
  });
}

function safeReason(error: unknown): string {
  // A guardian error already carries a code and a message vetted for display.
  if (error instanceof GuardianRecoveryError) return `${error.code}: ${error.safeMessage}`;
  if (error instanceof Error) {
    const known = KNOWN.find(candidate => error.message === candidate);
    return known ?? `${error.name || "Error"} (message withheld)`;
  }
  return "unknown failure";
}

/** One sentence naming every draft that failed, and how far each one got. */
export function summarizeDraftFailures(failures: readonly DraftFailure[]): string {
  if (failures.length === 0) return "";
  const each = failures.map(failure => `“${failure.label}” ${STAGE_TEXT[failure.stage]} — ${failure.reason}`);
  const plural = failures.length === 1 ? "" : "s";
  return `${failures.length} saved recovery draft${plural} on this device could not be used: ${each.join("; ")}.`;
}
