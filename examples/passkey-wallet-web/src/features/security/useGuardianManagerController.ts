import { useReducer } from "react";

export type GuardianManagerState =
  | { readonly view: "list" | "review"; readonly status: "idle"; readonly error: string }
  | { readonly view: "list" | "review"; readonly status: "working"; readonly error: string };

export type GuardianManagerEvent =
  | { readonly type: "VIEW"; readonly view: GuardianManagerState["view"] }
  | { readonly type: "WORKING"; readonly working: boolean }
  | { readonly type: "ERROR"; readonly error: string };

export function reduceGuardianManagerState(state: GuardianManagerState, event: GuardianManagerEvent): GuardianManagerState {
  switch (event.type) {
    case "VIEW": return Object.freeze({ ...state, view: event.view });
    case "WORKING": return Object.freeze({ ...state, status: event.working ? "working" : "idle" });
    case "ERROR": return Object.freeze({ ...state, error: event.error });
  }
}

export function useGuardianManagerController() {
  const [state, dispatch] = useReducer(reduceGuardianManagerState, { view: "list", status: "idle", error: "" });
  return {
    stage: state.view,
    busy: state.status === "working",
    error: state.error,
    setStage: (view: GuardianManagerState["view"]) => dispatch({ type: "VIEW", view }),
    setBusy: (working: boolean) => dispatch({ type: "WORKING", working }),
    setError: (error: string) => dispatch({ type: "ERROR", error })
  } as const;
}
