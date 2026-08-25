import type { RecoverySession } from "./recoverySession.ts";

/**
 * A recovery stage in the words shown to whoever is reading it.
 *
 * Kept as one exhaustive record rather than a chain of conditionals: adding a
 * stage to the session without naming it here becomes a type error instead of a
 * blank badge, and a blank badge on a recovery is the worst way to learn that a
 * state exists.
 */
const STAGE_LABELS: Readonly<Record<RecoverySession["stage"], string>> = Object.freeze({
  "request-created": "Request ready",
  collecting: "Collecting approvals",
  "ready-to-propose": "Ready to propose",
  "delay-active": "Security delay active",
  "ready-to-execute": "Ready to execute",
  completed: "Recovery completed",
  cancelled: "Recovery cancelled",
  expired: "Recovery expired",
  blocked: "Recovery blocked"
});

export function shortStage(stage: RecoverySession["stage"]): string {
  return STAGE_LABELS[stage];
}
