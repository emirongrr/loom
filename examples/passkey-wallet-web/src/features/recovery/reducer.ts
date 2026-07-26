import type { RecoveryFlowState, WalletDomainError } from "../../types";

export type RecoveryAction =
  | { type: "LOAD_ACCOUNT" }
  | { type: "CREATE_PASSKEY" }
  | { type: "COLLECT"; have: number; need: number; authenticationCode: string }
  | { type: "READY"; authenticationCode: string }
  | { type: "PROPOSING" }
  | { type: "PROPOSED"; readyAt: bigint; expiresAt: bigint }
  | { type: "TICK"; now: bigint }
  | { type: "EXECUTE" }
  | { type: "COMPLETE"; account: `0x${string}` }
  | { type: "CANCEL" }
  | { type: "FAIL"; error: WalletDomainError }
  | { type: "RESET" };

export const initialRecoveryState: RecoveryFlowState = { status: "idle" };

export function recoveryReducer(state: RecoveryFlowState, action: RecoveryAction): RecoveryFlowState {
  switch (action.type) {
    case "LOAD_ACCOUNT": return state.status === "idle" || state.status === "error" ? { status: "loading-account" } : state;
    case "CREATE_PASSKEY": return state.status === "loading-account" ? { status: "creating-passkey" } : state;
    case "COLLECT": return state.status === "creating-passkey" || state.status === "collecting-approvals"
      ? { status: "collecting-approvals", have: action.have, need: action.need, authenticationCode: action.authenticationCode }
      : state;
    case "READY": return state.status === "collecting-approvals" && state.have >= state.need
      ? { status: "ready-to-propose", authenticationCode: action.authenticationCode }
      : state;
    case "PROPOSING": return state.status === "ready-to-propose" ? { status: "proposal-pending" } : state;
    case "PROPOSED": return state.status === "proposal-pending" ? { status: "delay-active", readyAt: action.readyAt, expiresAt: action.expiresAt } : state;
    case "TICK": {
      if (state.status === "delay-active" && action.now > state.expiresAt) return { status: "expired" };
      if (state.status === "delay-active" && action.now >= state.readyAt) return { status: "ready-to-execute", expiresAt: state.expiresAt };
      if (state.status === "ready-to-execute" && action.now > state.expiresAt) return { status: "expired" };
      return state;
    }
    case "EXECUTE": return state.status === "ready-to-execute" ? { status: "executing" } : state;
    case "COMPLETE": return state.status === "executing" ? { status: "complete", account: action.account } : state;
    case "CANCEL": return ["proposal-pending", "delay-active", "ready-to-execute"].includes(state.status) ? { status: "cancelled" } : state;
    case "FAIL": return { status: "error", error: action.error };
    case "RESET": return initialRecoveryState;
  }
}

export function authenticationCode(digest: `0x${string}`): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error("recovery digest must be bytes32");
  return digest.slice(2, 18).toUpperCase().match(/.{4}/gu)!.join("-");
}
