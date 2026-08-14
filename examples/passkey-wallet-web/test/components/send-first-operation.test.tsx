import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { NotificationsProvider } from "../../src/notifications/NotificationsContext.tsx";
import { SendDialog } from "../../src/features/send/SendDialog.tsx";
import type { AccountAssets } from "../../src/features/wallet/assets.ts";
import type { AccountHandle } from "../../src/types.ts";

const factory = "0x1111111111111111111111111111111111111112";

const deployment = {
  chainId: 11_155_111,
  entryPoint: "0x1111111111111111111111111111111111111111",
  factory,
  implementation: "0x1111111111111111111111111111111111111113",
  validator: "0x1111111111111111111111111111111111111114",
  policyHook: "0x1111111111111111111111111111111111111115",
  proxyCreationCode: "0x00",
  runtimeCodeHashes: {
    entryPoint: `0x${"11".repeat(32)}`, factory: `0x${"12".repeat(32)}`, implementation: `0x${"13".repeat(32)}`,
    validator: `0x${"14".repeat(32)}`, policyHook: `0x${"15".repeat(32)}`
  }
} as never;

// The creation call is rebuilt from the saved handle, and refuses to produce one
// that would not re-derive this exact address. Both outcomes are exercised here.
const planActivation = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/wallet/activate.ts", () => ({ planActivation }));

afterEach(cleanup);

const assets: AccountAssets = {
  native: { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 10n ** 18n, formatted: "1.0" },
  tokens: [], nfts: [], deployed: false, discoveryUnavailable: false, nftDiscoveryUnavailable: false
};

function account(): AccountHandle {
  return {
    version: 1, kind: "derived", id: "wallet", label: "Wallet",
    account: "0xcccccccccccccccccccccccccccccccccccccccc", chainId: 11_155_111,
    credentialId: "0xab", publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174",
    salt: `0x${"5a".repeat(32)}`,
    creation: { guardianRoot: `0x${"00".repeat(32)}`, guardianThreshold: 0 }
  } as unknown as AccountHandle;
}

function services(): AppServices {
  return {
    guardianVault: {}, invitationLinks: {}, accounts: {},
    publicClients: { forEndpoint: () => ({}) }, runtime: {}, pendingOperations: {},
    now: () => 1_900_000_000_000
  } as unknown as AppServices;
}

function open(deployed: boolean) {
  render(
    <NetworkProvider><NotificationsProvider>
      <AppServicesProvider services={services()}>
        <SendDialog account={account()} deployment={deployment} deployed={deployed} assets={assets} onClose={() => undefined} />
      </AppServicesProvider>
    </NotificationsProvider></NetworkProvider>
  );
}

test("a first send from an account that does not exist yet is allowed, not blocked", () => {
  planActivation.mockReturnValue({ factory, factoryData: "0xdeadbeef", salt: `0x${"5a".repeat(32)}`, recoveryStatus: "unprotected" });
  open(false);

  // The old screen disabled submit and told the user to go and activate first.
  expect(screen.getByRole("button", { name: /sign & send with passkey/iu }).hasAttribute("disabled")).toBe(false);
  const notice = screen.getByTestId("first-send-notice");
  expect(notice.textContent).toMatch(/creates it and makes the transfer in one operation/iu);
  expect(notice.textContent).toMatch(/no second passkey prompt/iu);
});

test("the notice states the failure case rather than promising atomicity", () => {
  planActivation.mockReturnValue({ factory, factoryData: "0xdeadbeef", salt: `0x${"5a".repeat(32)}`, recoveryStatus: "unprotected" });
  open(false);

  // Creation happens in the validation phase, so a reverting transfer leaves the
  // account created. Saying otherwise would be a false promise.
  expect(screen.getByTestId("first-send-notice").textContent)
    .toMatch(/the account is still created and nothing is sent/iu);
});

test("a handle whose creation call cannot be rebuilt still refuses to send", () => {
  planActivation.mockImplementation(() => { throw new Error("configuration could not be reproduced"); });
  open(false);

  expect(screen.getByRole("button", { name: /sign & send with passkey/iu }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByTestId("first-send-notice").textContent).toMatch(/cannot be rebuilt/iu);
});

test("an account that already exists shows no first-send notice at all", () => {
  planActivation.mockReturnValue({ factory, factoryData: "0xdeadbeef", salt: `0x${"5a".repeat(32)}`, recoveryStatus: "unprotected" });
  open(true);

  expect(screen.queryByTestId("first-send-notice")).toBeNull();
  expect(screen.getByRole("button", { name: /sign & send with passkey/iu }).hasAttribute("disabled")).toBe(false);
});
