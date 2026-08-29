import { GuardianRecoveryError } from "@loom/sdk/recovery";

/**
 * What a failed recovery step is allowed to say.
 *
 * Recovery errors can carry chain state, guardian material, and the contents of
 * a request. None of that belongs on screen, so anything not written by this
 * repository collapses into one sentence naming the three things a reader can
 * actually check. The collapse is the point: it is a boundary, not a fallback.
 */
export function safeRecoveryMessage(error: unknown): string {
  if (error instanceof GuardianRecoveryError) return error.safeMessage;
  return "Recovery state could not be verified. Check the account, network, and RPC, then retry.";
}

/**
 * Why an announcement did not go out, in the announcer's own terms.
 *
 * `safeRecoveryMessage` collapses everything into one sentence about the
 * account, the network and the RPC, which is right where an error might carry
 * something about the recovery itself. Nothing on this path does: every message
 * here is written either by this repository -- the deployment loader, the
 * runtime verifier -- or by the reader's own wallet telling them what it
 * refused. Collapsing those hid the one thing that would let them fix it.
 */
export function announceFailure(error: unknown): string {
  if (error instanceof GuardianRecoveryError) return `${error.code}: ${error.safeMessage}`;
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  return safeRecoveryMessage(error);
}
