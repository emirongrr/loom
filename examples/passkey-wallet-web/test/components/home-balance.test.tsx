import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { NotificationsProvider } from "../../src/notifications/NotificationsContext.tsx";
import { HomePage } from "../../src/features/home/HomePage.tsx";
import type { AccountHandle } from "../../src/types.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";

function account(): AccountHandle {
  return {
    version: 1, kind: "created", id: "wallet-1", label: "My wallet", account: ACCOUNT,
    chainId: 11_155_111, credentialId: "0x01",
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"33".repeat(20)}`
  };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  // The explorer index and the deployment manifest both degrade on failure;
  // neither is what these tests are about.
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 500 })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; cleanup(); });

function services(chain: { getBalance: () => Promise<bigint>; getCode: () => Promise<string> }): AppServices {
  return {
    accounts: {}, guardianVault: {}, guardianRoster: {}, invitationLinks: {},
    publicClients: { forEndpoint: () => chain },
    runtime: { verify: async () => undefined },
    pendingOperations: { list: async () => [] },
    now: () => 1_900_000_000_000
  } as unknown as AppServices;
}

const view = (chain: Parameters<typeof services>[0]) => render(
  <NetworkProvider>
    <NotificationsProvider>
      <AppServicesProvider services={services(chain)}>
        <HomePage
          account={account()}
          onNavigate={() => undefined}
          onSwitch={() => undefined}
          onLock={() => undefined}
          onStopRecovery={() => undefined}
        />
      </AppServicesProvider>
    </NotificationsProvider>
  </NetworkProvider>
);

// A wallet that cannot reach the chain knows nothing about its balance. Showing
// a number anyway -- especially zero -- would be the wallet inventing the one
// fact the reader came for.
test("a balance that cannot be read is reported unavailable, never as zero", async () => {
  view({
    getBalance: async () => { throw new Error("rpc unreachable"); },
    getCode: async () => "0x"
  });

  await screen.findByText(/Balance unavailable/iu);
  expect(screen.queryByText(/^0 ETH$/u)).toBeNull();
});

test("a balance that reads as zero is shown as zero, which is a fact", async () => {
  view({ getBalance: async () => 0n, getCode: async () => "0x" });

  await screen.findByText(/0 ETH/u);
  expect(screen.queryByText(/Balance unavailable/iu)).toBeNull();
});

test("a funded account shows what the chain returned", async () => {
  view({ getBalance: async () => 1_500_000_000_000_000_000n, getCode: async () => "0xff" });

  await screen.findByText(/1\.5 ETH/u);
});
