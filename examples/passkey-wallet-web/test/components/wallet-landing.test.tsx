import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletLanding } from "../../src/features/onboarding/WalletLanding";
import type { AccountHandle } from "../../src/types";
import { NetworkProvider } from "../../src/config/NetworkContext";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices";

afterEach(cleanup);

const account = {
  version: 1,
  kind: "derived",
  id: "wallet-1",
  label: "Primary wallet",
  account: "0x1111111111111111111111111111111111111111",
  chainId: 11155111,
  credentialId: "0x01",
  publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
  rpId: "localhost",
  origin: "http://localhost:5174",
  salt: `0x${"33".repeat(32)}`,
  creation: { guardianRoot: `0x${"00".repeat(32)}`, guardianThreshold: 0 }
} as AccountHandle;

const services = { publicClients: {} } as AppServices;

function renderLanding(input: {
  readonly onRemove: (account: AccountHandle) => Promise<void>;
  readonly onOpen?: (account: AccountHandle) => Promise<void>;
}) {
  return render(<NetworkProvider><AppServicesProvider services={services}><WalletLanding
    accounts={[account]}
    busy={false}
    message=""
    onCreate={async () => undefined}
    onImport={async () => undefined}
    onOpen={input.onOpen ?? (async () => undefined)}
    onRemove={input.onRemove}
    onGuardianRecover={() => undefined}
    onClearMessage={() => undefined}
  /></AppServicesProvider></NetworkProvider>);
}

describe("WalletLanding saved wallet removal", () => {
  it("requires confirmation and removes only the selected saved-wallet entry", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => undefined);
    const onOpen = vi.fn(async () => undefined);
    renderLanding({ onRemove, onOpen });

    await user.click(screen.getByRole("button", { name: "Remove Primary wallet" }));
    assert.ok(screen.getByRole("dialog", { name: "Remove saved wallet" }));
    assert.match(screen.getByText(/does not delete the on-chain account/u).textContent ?? "", /passkey/u);
    assert.equal(onRemove.mock.calls.length, 0);

    const confirmButton = screen.getByRole("button", { name: "Remove from Saved Wallets" });
    assert.equal(confirmButton.hasAttribute("disabled"), true);
    await user.type(screen.getByRole("textbox", { name: "Type REMOVE to confirm" }), "REMOVE");
    assert.equal(confirmButton.hasAttribute("disabled"), false);
    await user.click(confirmButton);
    assert.equal(onRemove.mock.calls.length, 1);
    assert.equal(onRemove.mock.calls[0]?.[0], account);
    assert.equal(onOpen.mock.calls.length, 0);
  });

  it("cancels without removing the wallet", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => undefined);
    renderLanding({ onRemove });

    await user.click(screen.getByRole("button", { name: "Remove Primary wallet" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    assert.equal(onRemove.mock.calls.length, 0);
    assert.equal(screen.queryByRole("dialog"), null);
  });

  it("keeps the confirmation open when removal fails", async () => {
    const user = userEvent.setup();
    renderLanding({ onRemove: async () => { throw new Error("storage unavailable"); } });

    await user.click(screen.getByRole("button", { name: "Remove Primary wallet" }));
    await user.type(screen.getByRole("textbox", { name: "Type REMOVE to confirm" }), "REMOVE");
    await user.click(screen.getByRole("button", { name: "Remove from Saved Wallets" }));
    assert.ok(screen.getByRole("dialog", { name: "Remove saved wallet" }));
  });
});
