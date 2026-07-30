import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecoveryStepper, recoveryViewStage } from "../../src/features/recovery/RecoveryStepper";

afterEach(cleanup);

describe("RecoveryStepper", () => {
  it("maps setup and lifecycle states to one of four meaningful views", () => {
    assert.equal(recoveryViewStage({}), "account-verification");
    assert.equal(recoveryViewStage({ showingPasskey: true }), "validator-provisioning");
    assert.equal(recoveryViewStage({ sessionStage: "collecting" }), "guardian-approvals");
    assert.equal(recoveryViewStage({ sessionStage: "delay-active" }), "delay-execution");
  });

  it("exposes exactly one current step", () => {
    render(<RecoveryStepper stage="guardian-approvals" />);
    const current = screen.getAllByRole("listitem").filter(item => item.getAttribute("aria-current") === "step");
    assert.equal(current.length, 1);
    assert.match(current[0]!.textContent ?? "", /Guardian approvals/);
  });
});
