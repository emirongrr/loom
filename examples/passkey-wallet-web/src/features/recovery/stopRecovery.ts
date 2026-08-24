import type { Address, Hex } from "@loom/core";

/**
 * What an account owner needs to know, and to do, about a recovery they did
 * not start.
 *
 * The warning on the wallet screen could say a recovery was underway but led
 * nowhere: an owner who read it had no way to see when it would happen or to
 * begin stopping it. Telling someone their account is being taken and leaving
 * them with no next step is worse than not telling them, because it spends the
 * one thing they have -- attention -- and returns nothing.
 *
 * Cancelling is deliberately not something the owner can do alone. It takes
 * the account plus one fewer than the guardian threshold, or the full
 * threshold of guardians without the account (ADR-0023). An attacker holding
 * the account key must not be able to block a recovery the guardians genuinely
 * approved, so the account's own signature is never sufficient. This plans
 * around that rule rather than hiding it.
 */
export type StopPhase = "delay" | "executable" | "expired";

export interface StopRoute {
  readonly id: "account-and-guardians" | "guardians-only";
  readonly title: string;
  readonly detail: string;
  /** Guardian signatures this route needs, beyond whatever the account gives. */
  readonly guardiansNeeded: number;
  readonly needsAccount: boolean;
  /** Whether this route can be taken from here at all. */
  readonly available: boolean;
  readonly collected: number;
  readonly satisfied: boolean;
}

export interface StopMilestone {
  readonly id: "proposed" | "executable" | "expires";
  readonly label: string;
  readonly at: bigint;
  readonly reached: boolean;
}

export interface StopRecoveryPlan {
  readonly newValidator: Address;
  readonly phase: StopPhase;
  readonly headline: string;
  readonly urgency: string;
  readonly milestones: readonly StopMilestone[];
  readonly remaining: string;
  readonly routes: readonly StopRoute[];
  readonly guardianThreshold: number;
}

export function planStopRecovery(input: {
  readonly newValidator: Address;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
  readonly guardianThreshold: number;
  readonly nowSeconds: bigint;
  readonly accountAvailable: boolean;
  readonly collectedGuardians: number;
}): StopRecoveryPlan {
  const threshold = Math.max(1, Math.trunc(input.guardianThreshold));
  const phase: StopPhase = input.nowSeconds > input.expiresAt
    ? "expired"
    : input.nowSeconds >= input.readyAt ? "executable" : "delay";

  // The delay is fixed by the contract, so the proposal time is recoverable
  // from readyAt without another chain read.
  const proposedAt = input.readyAt - RECOVERY_DELAY_SECONDS;
  const collected = Math.max(0, Math.trunc(input.collectedGuardians));

  const withAccount = Math.max(1, threshold - 1);
  // At a threshold of one the routes collapse: the account route would still
  // need one guardian, which is the whole of the other route. Offering both
  // would be describing one thing twice, and the account one is strictly the
  // more troublesome of the two.
  const accountRouteHelps = threshold > 1 && input.accountAvailable;
  const routes: readonly StopRoute[] = Object.freeze([
    Object.freeze({
      id: "account-and-guardians" as const,
      title: `This wallet plus ${withAccount} guardian${withAccount === 1 ? "" : "s"}`,
      detail: threshold <= 1
        ? "With a threshold of one this asks for the same single guardian as the route below, and additionally for"
          + " the account. Use the other one."
        : input.accountAvailable
          ? "You are signed in to the account, so this is the shorter route. The account alone is never enough:"
            + " if it were, anyone holding a stolen key could block the guardians trying to take the account back."
          : "Needs the account's own key, which is not unlocked here. Open the account first, or use the guardian-only route.",
      guardiansNeeded: withAccount,
      needsAccount: true,
      available: accountRouteHelps,
      collected,
      satisfied: accountRouteHelps && collected >= withAccount
    }),
    Object.freeze({
      id: "guardians-only" as const,
      title: `${threshold} guardian${threshold === 1 ? "" : "s"}, without this wallet`,
      detail: "Works even if the account key is lost or unusable. It asks for the full recovery threshold,"
        + " because without the account there is nothing else vouching for the request.",
      guardiansNeeded: threshold,
      needsAccount: false,
      available: true,
      collected,
      satisfied: collected >= threshold
    })
  ]);

  return Object.freeze({
    newValidator: input.newValidator,
    phase,
    guardianThreshold: threshold,
    headline: HEADLINES[phase],
    urgency: urgencyFor(phase, input.expiresAt - input.nowSeconds),
    remaining: remainingFor(phase, input),
    milestones: Object.freeze([
      Object.freeze({ id: "proposed" as const, label: "Guardians approved it", at: proposedAt, reached: input.nowSeconds >= proposedAt }),
      Object.freeze({ id: "executable" as const, label: "Anyone can execute it", at: input.readyAt, reached: input.nowSeconds >= input.readyAt }),
      Object.freeze({ id: "expires" as const, label: "It can no longer be executed", at: input.expiresAt, reached: input.nowSeconds > input.expiresAt })
    ]),
    routes
  });
}

/** RecoveryManager.RECOVERY_DELAY. */
export const RECOVERY_DELAY_SECONDS = 259_200n;

const HEADLINES: Readonly<Record<StopPhase, string>> = Object.freeze({
  delay: "A recovery of this account is waiting out its delay.",
  executable: "A recovery of this account can be executed right now.",
  expired: "A recovery of this account has expired without being executed."
});

function urgencyFor(phase: StopPhase, secondsLeft: bigint): string {
  if (phase === "expired") {
    // Still worth cancelling: the slot stays occupied, and a pending recovery
    // blocks a new one -- including one the owner may want.
    return "It can no longer take the account, but it still holds the recovery slot."
      + " No new recovery can be proposed until this one is cancelled.";
  }
  if (phase === "executable") {
    return "The delay has passed. Whoever proposed it can complete it at any moment,"
      + " and when they do, control moves away from this wallet's key.";
  }
  return `Once the delay passes it stays executable for ${Math.round(Number(secondsLeft) / 86_400)} more day(s).`
    + " Cancelling is only possible while it is pending, so the time to act is now.";
}

function remainingFor(phase: StopPhase, input: { readonly readyAt: bigint; readonly expiresAt: bigint; readonly nowSeconds: bigint }): string {
  if (phase === "expired") return "Expired";
  const target = phase === "executable" ? input.expiresAt : input.readyAt;
  const seconds = target - input.nowSeconds;
  const prefix = phase === "executable" ? "Window closes in" : "Executable in";
  return `${prefix} ${humanDuration(seconds)}`;
}

export function humanDuration(seconds: bigint): string {
  if (seconds <= 0n) return "moments";
  if (seconds < 3600n) return `${Number(seconds / 60n)} minute(s)`;
  if (seconds < 86_400n) return `${Number(seconds / 3600n)} hour(s)`;
  const days = seconds / 86_400n;
  const hours = (seconds % 86_400n) / 3600n;
  return hours === 0n ? `${Number(days)} day(s)` : `${Number(days)} day(s), ${Number(hours)} hour(s)`;
}

/**
 * Which route the page should put first.
 *
 * The account route asks fewer people, so it wins when the account is open.
 * It is never the only one offered: an owner whose key is gone is exactly the
 * person most likely to be reading this.
 */
export function preferredRoute(plan: StopRecoveryPlan): StopRoute {
  return plan.routes.find(route => route.available && route.needsAccount) ?? plan.routes[1] ?? plan.routes[0]!;
}

export function shortAddress(value: Address | Hex): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
