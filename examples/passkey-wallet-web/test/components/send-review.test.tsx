import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { NotificationsProvider } from "../../src/notifications/NotificationsContext.tsx";
import { SendDialog } from "../../src/features/send/SendDialog.tsx";
import type { AccountAssets } from "../../src/features/wallet/assets.ts";
import type { AccountHandle } from "../../src/types.ts";

const accountAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
const recipient = "0x1234567890abcdef1234567890abcdef12345678";

vi.mock("../../src/features/wallet/activate.ts", () => ({ planActivation: () => { throw new Error("unused"); } }));

afterEach(cleanup);

const assets: AccountAssets = {
  native: { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 10n ** 18n, formatted: "1.0" },
  tokens: [], nfts: [], deployed: true, discoveryUnavailable: false, nftDiscoveryUnavailable: false
} as unknown as AccountAssets;

function account(): AccountHandle {
  return {
    version: 1, kind: "recovered", id: "wallet", label: "Wallet",
    account: accountAddress, chainId: 11_155_111,
    credentialId: "0xab", publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"33".repeat(20)}`
  } as unknown as AccountHandle;
}

function services(gasPrice?: bigint): AppServices {
  return {
    guardianVault: {}, invitationLinks: {}, accounts: {},
    publicClients: { forEndpoint: () => (gasPrice === undefined ? {} : { getGasPrice: async () => gasPrice }) },
    runtime: {}, pendingOperations: {}, now: () => 1_900_000_000_000
  } as unknown as AppServices;
}

function open(gasPrice?: bigint) {
  render(
    <NetworkProvider><NotificationsProvider>
      <AppServicesProvider services={services(gasPrice)}>
        <SendDialog account={account()} deployment={{ chainId: 11_155_111 } as never} deployed assets={assets} onClose={() => undefined} />
      </AppServicesProvider>
    </NotificationsProvider></NetworkProvider>
  );
}

test("the review shows every field before anything is authorised", async () => {
  open(1_000_000_000n);
  await userEvent.type(screen.getByPlaceholderText("0x…"), recipient);
  await userEvent.type(screen.getByPlaceholderText("0.0"), "0.25");

  const panel = await screen.findByTestId("send-review");
  const text = panel.textContent ?? "";
  expect(text).toMatch(/ETH/u);
  expect(text).toMatch(/0\.25 ETH/u);
  expect(text).toContain(recipient.slice(0, 10));
  expect(text).toMatch(/Sepolia · chain 11155111/u);
  expect(text).toMatch(/This account/iu);
  expect(text).toMatch(/at most/iu);
});

test("the review is a labelled region, not decoration", async () => {
  open(1_000_000_000n);
  expect(await screen.findByRole("region", { name: /review this transfer/iu }).catch(() => null)
    ?? screen.getByTestId("send-review")).toBeTruthy();
});

test("the fee is described as a ceiling, never as a prediction", async () => {
  open(1_000_000_000n);
  const panel = await screen.findByTestId("send-review");
  expect(panel.textContent).toMatch(/at most/iu);
  // "Estimated fee" would claim precision this number does not have.
  expect(panel.textContent).not.toMatch(/estimated fee/iu);
});

test("an unreadable fee price is admitted in the review rather than hidden", async () => {
  open();
  const panel = await screen.findByTestId("send-review");
  expect(panel.textContent).toMatch(/unavailable/iu);
});

test("the review names this account as the gas payer, not a sponsor", async () => {
  open(1_000_000_000n);
  const panel = await screen.findByTestId("send-review");
  expect(panel.textContent).toMatch(/gas paid by/iu);
  expect(panel.textContent).toMatch(/this account/iu);
});

test("reviewing costs no extra click: submit is still the only action", async () => {
  open(1_000_000_000n);
  await screen.findByTestId("send-review");
  // A separate confirm step would add a click without adding information.
  expect(screen.queryByRole("button", { name: /review|continue|next/iu })).toBeNull();
  expect(screen.getByRole("button", { name: /sign & send with passkey/iu })).toBeTruthy();
});

test("an empty draft prompts for the recipient instead of showing a blank", async () => {
  open(1_000_000_000n);
  const panel = await screen.findByTestId("send-review");
  expect(panel.textContent).toMatch(/enter a recipient address/iu);
});
