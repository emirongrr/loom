import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { NotificationsProvider } from "../../src/notifications/NotificationsContext.tsx";
import { SendDialog } from "../../src/features/send/SendDialog.tsx";
import type { AccountAssets } from "../../src/features/wallet/assets.ts";
import type { AccountHandle } from "../../src/types.ts";

const accountAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
const tokenAddress = "0xabcdef0000000000000000000000000000abcdef";
const lookAlike = "0xabcdef1111111111111111111111111111abcdef";

vi.mock("../../src/features/wallet/activate.ts", () => ({ planActivation: () => { throw new Error("not used"); } }));

afterEach(cleanup);

const assets: AccountAssets = {
  native: { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 10n ** 18n, formatted: "1.0" },
  tokens: [{ kind: "erc20", address: tokenAddress, symbol: "USDC", name: "USD Coin", decimals: 6, balance: 5_000_000n, formatted: "5.0" }],
  nfts: [], deployed: true, discoveryUnavailable: false, nftDiscoveryUnavailable: false
} as unknown as AccountAssets;

function account(): AccountHandle {
  return {
    version: 3, kind: "recovered", id: "wallet", label: "Wallet",
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

test("Max keeps a gas reserve back instead of offering the whole balance", async () => {
  open(1_000_000_000n);
  await screen.findByTestId("gas-reserve");

  await userEvent.click(screen.getByRole("button", { name: /^max$/iu }));
  const amount = screen.getByPlaceholderText("0.0") as HTMLInputElement;

  expect(amount.value).not.toBe("1.0");
  expect(Number(amount.value)).toBeGreaterThan(0);
  expect(Number(amount.value)).toBeLessThan(1);
  expect(screen.getByTestId("gas-reserve").textContent).toMatch(/pay for its own transfer/iu);
});

test("Max is withheld rather than guessed when the fee price is unknown", async () => {
  open();
  await screen.findByTestId("gas-reserve-unavailable");
  expect(screen.getByRole("button", { name: /^max$/iu }).hasAttribute("disabled")).toBe(true);
});

test("an address that mimics a known one at both ends warns before sending", async () => {
  open(1_000_000_000n);
  await userEvent.type(screen.getByPlaceholderText("0x…"), lookAlike);

  await waitFor(() => { expect(screen.getByTestId("recipient-risks")).toBeTruthy(); });
  const text = screen.getByTestId("recipient-risks").textContent ?? "";
  expect(text).toMatch(/begins and ends like USDC/iu);
  expect(text).toMatch(/address-poisoning/iu);
});

test("sending to the account's own address is called out", async () => {
  open(1_000_000_000n);
  await userEvent.type(screen.getByPlaceholderText("0x…"), accountAddress);

  await waitFor(() => { expect(screen.getByTestId("recipient-risks")).toBeTruthy(); });
  expect(screen.getByTestId("recipient-risks").textContent).toMatch(/this account's own address/iu);
});

test("the exact token contract is named as a contract, not as a look-alike", async () => {
  open(1_000_000_000n);
  await userEvent.type(screen.getByPlaceholderText("0x…"), tokenAddress);

  await waitFor(() => { expect(screen.getByTestId("recipient-risks")).toBeTruthy(); });
  const text = screen.getByTestId("recipient-risks").textContent ?? "";
  expect(text).toMatch(/the USDC contract itself/iu);
  expect(text).not.toMatch(/begins and ends like/iu);
});

test("an ordinary recipient produces no warning at all", async () => {
  open(1_000_000_000n);
  await userEvent.type(screen.getByPlaceholderText("0x…"), "0x1234567890abcdef1234567890abcdef12345678");

  await screen.findByTestId("gas-reserve");
  expect(screen.queryByTestId("recipient-risks")).toBeNull();
});
