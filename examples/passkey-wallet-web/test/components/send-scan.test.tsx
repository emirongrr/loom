import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { NotificationsProvider } from "../../src/notifications/NotificationsContext.tsx";
import { SendDialog } from "../../src/features/send/SendDialog.tsx";
import type { AccountAssets } from "../../src/features/wallet/assets.ts";
import type { AccountHandle } from "../../src/types.ts";

const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

vi.mock("../../src/features/wallet/activate.ts", () => ({ planActivation: () => { throw new Error("unused"); } }));

const scan = vi.hoisted(() => vi.fn());
const available = vi.hoisted(() => ({ value: true }));
vi.mock("../../src/features/wallet/scanRecipient.ts", () => ({
  createRecipientScanner: () => ({ get available() { return available.value; }, scan })
}));

afterEach(() => { cleanup(); available.value = true; });

const assets: AccountAssets = {
  native: { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 10n ** 18n, formatted: "1.0" },
  tokens: [], nfts: [], deployed: true, discoveryUnavailable: false, nftDiscoveryUnavailable: false
} as unknown as AccountAssets;

function account(): AccountHandle {
  return {
    version: 1, kind: "recovered", id: "wallet", label: "Wallet",
    account: "0xcccccccccccccccccccccccccccccccccccccccc", chainId: 11_155_111,
    credentialId: "0xab", publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"33".repeat(20)}`
  } as unknown as AccountHandle;
}

function open() {
  render(
    <NetworkProvider><NotificationsProvider>
      <AppServicesProvider services={{
        guardianVault: {}, invitationLinks: {}, accounts: {},
        publicClients: { forEndpoint: () => ({ getGasPrice: async () => 1_000_000_000n }) },
        runtime: {}, pendingOperations: {}, now: () => 1_900_000_000_000
      } as unknown as AppServices}>
        <SendDialog account={account()} deployment={{ chainId: 11_155_111 } as never} deployed assets={assets} onClose={() => undefined} />
      </AppServicesProvider>
    </NotificationsProvider></NetworkProvider>
  );
}

test("the camera is never started without an explicit press", async () => {
  open();
  await screen.findByTestId("scan-recipient");
  expect(scan).not.toHaveBeenCalled();
});

test("a scanned address fills the recipient field", async () => {
  scan.mockResolvedValue(checksummed.toLowerCase());
  open();
  await userEvent.click(screen.getByTestId("scan-recipient"));

  await waitFor(() => {
    expect((screen.getByPlaceholderText("0x…") as HTMLInputElement).value).toBe(checksummed);
  });
});

test("a code for another network is refused and the field is left alone", async () => {
  scan.mockResolvedValue(`ethereum:${checksummed.toLowerCase()}@1`);
  open();
  await userEvent.click(screen.getByTestId("scan-recipient"));

  const issue = await screen.findByTestId("scan-issue");
  expect(issue.textContent).toMatch(/another network/iu);
  expect((screen.getByPlaceholderText("0x…") as HTMLInputElement).value).toBe("");
});

test("a token-transfer request is refused rather than reduced to its address", async () => {
  scan.mockResolvedValue(`ethereum:${checksummed.toLowerCase()}@11155111/transfer?address=${checksummed.toLowerCase()}&uint256=1`);
  open();
  await userEvent.click(screen.getByTestId("scan-recipient"));

  expect((await screen.findByTestId("scan-issue")).textContent).toMatch(/token transfer/iu);
  expect((screen.getByPlaceholderText("0x…") as HTMLInputElement).value).toBe("");
});

test("a camera failure points back at typing instead of stalling", async () => {
  scan.mockRejectedValue(new Error("permission denied"));
  open();
  await userEvent.click(screen.getByTestId("scan-recipient"));

  expect((await screen.findByTestId("scan-issue")).textContent).toMatch(/type or paste/iu);
});

test("a browser that cannot decode offers no scan button at all", async () => {
  available.value = false;
  open();
  await screen.findByPlaceholderText("0x…");
  // A dead button would be worse than none; typing remains the way in.
  expect(screen.queryByTestId("scan-recipient")).toBeNull();
});
