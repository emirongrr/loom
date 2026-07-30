import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "../../src/components/Dialog";

afterEach(cleanup);

describe("Dialog", () => {
  it("moves focus inside, closes with Escape, and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<Dialog label="Review transfer" onClose={onClose}><button>Cancel</button><button>Confirm</button></Dialog>);

    assert.equal(document.activeElement, screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    assert.equal(onClose.mock.calls.length, 1);
    view.unmount();
    assert.equal(document.activeElement, opener);
    opener.remove();
  });

  it("traps Tab focus and does not close while busy", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Dialog label="Review transfer" busy onClose={onClose}><button>First</button><button>Last</button></Dialog>);

    screen.getByRole("button", { name: "Last" }).focus();
    await user.tab();
    assert.equal(document.activeElement, screen.getByRole("button", { name: "First" }));
    await user.keyboard("{Escape}");
    assert.equal(onClose.mock.calls.length, 0);
  });
});
