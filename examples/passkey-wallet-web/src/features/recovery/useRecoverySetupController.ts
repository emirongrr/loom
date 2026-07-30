import { useReducer } from "react";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { PreparedRecoveryPasskey } from "./recoveryPasskey";

export type RecoveryInspection =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "protected"; readonly account: `0x${string}`; readonly threshold: number; readonly configVersion: string; readonly validators: number; readonly deployment: WalletDeployment }
  | { readonly status: "blocked"; readonly message: string };

export type RecoveryProvisioningStatus = "idle" | "creating" | "prepared" | "publishing" | "published";

export interface RecoverySetupState {
  readonly inspection: RecoveryInspection;
  readonly view: "account-verification" | "validator-provisioning";
  readonly provisioning: {
    readonly status: RecoveryProvisioningStatus;
    readonly preparation: PreparedRecoveryPasskey | null;
  };
}

export type RecoverySetupEvent =
  | { readonly type: "INSPECTION"; readonly inspection: RecoveryInspection }
  | { readonly type: "VIEW"; readonly view: RecoverySetupState["view"] }
  | { readonly type: "PROVISIONING_STATUS"; readonly status: RecoveryProvisioningStatus }
  | { readonly type: "PREPARATION"; readonly preparation: PreparedRecoveryPasskey | null };

export function reduceRecoverySetupState(state: RecoverySetupState, event: RecoverySetupEvent): RecoverySetupState {
  switch (event.type) {
    case "INSPECTION": return Object.freeze({ ...state, inspection: event.inspection });
    case "VIEW": return Object.freeze({ ...state, view: event.view });
    case "PROVISIONING_STATUS": return Object.freeze({ ...state, provisioning: Object.freeze({ ...state.provisioning, status: event.status }) });
    case "PREPARATION": return Object.freeze({ ...state, provisioning: Object.freeze({ ...state.provisioning, preparation: event.preparation }) });
  }
}

export function useRecoverySetupController() {
  const [state, dispatch] = useReducer(reduceRecoverySetupState, {
    inspection: { status: "idle" },
    view: "account-verification",
    provisioning: { status: "idle", preparation: null }
  });
  return {
    inspection: state.inspection,
    showPasskey: state.view === "validator-provisioning",
    passkeyStatus: state.provisioning.status,
    passkeyPreparation: state.provisioning.preparation,
    setInspection: (inspection: RecoveryInspection) => dispatch({ type: "INSPECTION", inspection }),
    setShowPasskey: (show: boolean) => dispatch({ type: "VIEW", view: show ? "validator-provisioning" : "account-verification" }),
    setPasskeyStatus: (status: RecoveryProvisioningStatus) => dispatch({ type: "PROVISIONING_STATUS", status }),
    setPasskeyPreparation: (preparation: PreparedRecoveryPasskey | null) => dispatch({ type: "PREPARATION", preparation })
  } as const;
}
