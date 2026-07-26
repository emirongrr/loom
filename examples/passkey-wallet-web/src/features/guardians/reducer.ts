import type { GuardianOnboardingState, WalletDomainError } from "../../types";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";

export type GuardianAction =
  | { type: "INVITE_CREATED"; invite: GuardianInviteV1 }
  | { type: "INVITE_DELIVERED"; receipt: string }
  | { type: "ACCEPTED" }
  | { type: "QUORUM"; accepted: number; threshold: number }
  | { type: "ACTIVATION_PENDING"; readyAt: bigint }
  | { type: "ACTIVE" }
  | { type: "STALE" }
  | { type: "REMOVE"; readyAt: bigint }
  | { type: "REMOVED" }
  | { type: "FAIL"; error: WalletDomainError };

export function guardianReducer(state: GuardianOnboardingState, action: GuardianAction): GuardianOnboardingState {
  switch (action.type) {
    case "INVITE_CREATED": return state.status === "draft" ? { status: "invite-created", invite: action.invite } : state;
    case "INVITE_DELIVERED": return state.status === "invite-created" ? { status: "invite-delivered", invite: state.invite, receipt: action.receipt } : state;
    case "ACCEPTED": return state.status === "invite-created" || state.status === "invite-delivered" ? { status: "accepted", invite: state.invite } : state;
    case "QUORUM": return state.status === "accepted" && action.accepted >= action.threshold ? { status: "ready-to-activate", accepted: action.accepted, threshold: action.threshold } : state;
    case "ACTIVATION_PENDING": return state.status === "ready-to-activate" ? { status: "activation-pending", readyAt: action.readyAt } : state;
    case "ACTIVE": return state.status === "activation-pending" ? { status: "active" } : state;
    case "STALE": return { status: "stale" };
    case "REMOVE": return state.status === "active" ? { status: "removal-pending", readyAt: action.readyAt } : state;
    case "REMOVED": return state.status === "removal-pending" ? { status: "removed" } : state;
    case "FAIL": return { status: "error", error: action.error };
  }
}
