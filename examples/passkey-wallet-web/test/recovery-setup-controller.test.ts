import assert from "node:assert/strict";
import test from "node:test";
import { reduceRecoverySetupState, type RecoverySetupState } from "../src/features/recovery/useRecoverySetupController.ts";

test("recovery setup keeps verification, view, and provisioning in one controller state", () => {
  let state: RecoverySetupState = {
    inspection: { status: "idle" },
    view: "account-verification",
    provisioning: { status: "idle", preparation: null }
  };
  state = reduceRecoverySetupState(state, { type: "INSPECTION", inspection: { status: "loading" } });
  state = reduceRecoverySetupState(state, { type: "VIEW", view: "validator-provisioning" });
  state = reduceRecoverySetupState(state, { type: "PROVISIONING_STATUS", status: "creating" });
  assert.equal(state.inspection.status, "loading");
  assert.equal(state.view, "validator-provisioning");
  assert.equal(state.provisioning.status, "creating");
});
