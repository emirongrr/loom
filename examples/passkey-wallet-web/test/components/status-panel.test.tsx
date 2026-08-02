import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AdvancedDetails, StatusPanel } from "../../src/components/StatusPanel";

afterEach(cleanup);

describe("StatusPanel", () => {
  it("announces status and exposes busy state", () => {
    render(<StatusPanel busy>Waiting for confirmation</StatusPanel>);
    const status = screen.getByRole("status");
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(status.getAttribute("aria-busy"), "true");
  });

  it("keeps technical details collapsed by default", () => {
    render(<AdvancedDetails><code>USER_OPERATION_TIMEOUT</code></AdvancedDetails>);
    const details = screen.getByText("Advanced details").closest("details");
    assert.ok(details);
    assert.equal(details.open, false);
  });
});
