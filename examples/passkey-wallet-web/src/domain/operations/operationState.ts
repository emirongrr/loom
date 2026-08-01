import type { Hex } from "@loom/core";
import type { AppError } from "../errors/appError";

export type OperationState =
  | { readonly status: "idle" }
  | { readonly status: "validating" }
  | { readonly status: "preparing" }
  | { readonly status: "estimating" }
  | { readonly status: "awaiting-passkey" }
  | { readonly status: "signing" }
  | { readonly status: "submitting" }
  | { readonly status: "confirming"; readonly userOperationHash: Hex }
  | { readonly status: "success"; readonly userOperationHash: Hex; readonly transactionHash: Hex }
  | { readonly status: "error"; readonly error: AppError; readonly userOperationHash?: Hex };

export type OperationEvent =
  | { readonly type: "VALIDATE" }
  | { readonly type: "PREPARE" }
  | { readonly type: "ESTIMATE" }
  | { readonly type: "REQUEST_PASSKEY" }
  | { readonly type: "SIGN" }
  | { readonly type: "SUBMIT" }
  | { readonly type: "CONFIRM"; readonly userOperationHash: Hex }
  | { readonly type: "SUCCEED"; readonly userOperationHash: Hex; readonly transactionHash: Hex }
  | { readonly type: "FAIL"; readonly error: AppError; readonly userOperationHash?: Hex }
  | { readonly type: "RESET" };

export function reduceOperationState(state: OperationState, event: OperationEvent): OperationState {
  if (!transitionAllowed(state.status, event.type)) {
    throw new Error(`Invalid operation transition: ${state.status} -> ${event.type}`);
  }
  switch (event.type) {
    case "VALIDATE": return Object.freeze({ status: "validating" });
    case "PREPARE": return Object.freeze({ status: "preparing" });
    case "ESTIMATE": return Object.freeze({ status: "estimating" });
    case "REQUEST_PASSKEY": return Object.freeze({ status: "awaiting-passkey" });
    case "SIGN": return Object.freeze({ status: "signing" });
    case "SUBMIT": return Object.freeze({ status: "submitting" });
    case "CONFIRM": return Object.freeze({ status: "confirming", userOperationHash: event.userOperationHash });
    case "SUCCEED": return Object.freeze({ status: "success", userOperationHash: event.userOperationHash, transactionHash: event.transactionHash });
    case "FAIL": return Object.freeze({ status: "error", error: event.error, ...(event.userOperationHash ? { userOperationHash: event.userOperationHash } : {}) });
    case "RESET": return Object.freeze({ status: "idle" });
  }
}

function transitionAllowed(status: OperationState["status"], event: OperationEvent["type"]): boolean {
  if (event === "FAIL") return !["idle", "success", "error"].includes(status);
  if (event === "RESET") return status === "success" || status === "error";
  if (event === "VALIDATE") return status === "idle" || status === "success" || status === "error";
  const allowed: Partial<Record<OperationState["status"], readonly OperationEvent["type"][]>> = {
    validating: ["PREPARE"],
    preparing: ["PREPARE", "ESTIMATE"],
    estimating: ["REQUEST_PASSKEY"],
    "awaiting-passkey": ["SIGN"],
    signing: ["SUBMIT"],
    submitting: ["CONFIRM"],
    confirming: ["SUCCEED"]
  };
  return allowed[status]?.includes(event) ?? false;
}

export function operationIsPending(state: OperationState): boolean {
  return !["idle", "success", "error"].includes(state.status);
}
