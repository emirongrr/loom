import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { createGuardianInvite, createGuardianSet } from "@loom/sdk/recovery";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import type { GuardianVaultSnapshot } from "../../src/storage/guardianVault.ts";
import type { AccountHandle } from "../../src/types.ts";

const protectedAccount = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const board = "0x6666666666666666666666666666666666666666";
const recoveryManager = "0x2222222222222222222222222222222222222222";

const deployment = {
  chainId: 11_155_111,
  entryPoint: "0x1111111111111111111111111111111111111111",
  factory: "0x1111111111111111111111111111111111111112",
  implementation: "0x1111111111111111111111111111111111111113",
  validator: "0x1111111111111111111111111111111111111114",
  policyHook: "0x1111111111111111111111111111111111111115",
  proxyCreationCode: "0x00",
  runtimeCodeHashes: {
    entryPoint: `0x${"11".repeat(32)}`, factory: `0x${"12".repeat(32)}`, implementation: `0x${"13".repeat(32)}`,
    validator: `0x${"14".repeat(32)}`, policyHook: `0x${"15".repeat(32)}`
  },
  recoveryModule: recoveryManager,
  recoveryIntentBoard: board
};

vi.mock("../../src/features/onboarding/accountLifecycle.ts", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadWalletDeployment: async () => deployment
}));

const discover = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/guardians/guardianDiscovery.ts", () => ({
  discoverGuardianRecoveryRequests: discover
}));

const { GuardianWorkspace } = await import("../../src/features/guardians/GuardianWorkspace.tsx");

afterEach(cleanup);

function guardianAccount(): AccountHandle {
  return {
    version: 3, kind: "recovered", id: "guardian", label: "Guardian",
    account: "0xcccccccccccccccccccccccccccccccccccccccc", chainId: 11_155_111,
    credentialId: "0xab", publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"33".repeat(20)}`
  };
}

function snapshot(open: AccountHandle): GuardianVaultSnapshot {
  const set = createGuardianSet({
    guardians: [{
      kind: "p256", publicKey: open.publicKey, credentialId: open.credentialId,
      verifier: "0x3333333333333333333333333333333333333333",
      verifierCodeHash: `0x${"a1".repeat(32)}`, salt: `0x${"c1".repeat(32)}`
    }],
    threshold: 1
  });
  const capability = createGuardianInvite({
    set, guardianLeaf: set.guardians[0].leaf, chainId: 11_155_111, account: protectedAccount,
    accountAlias: "Protected", issuerLabel: "Owner", guardianSetVersion: 1, configVersion: 1n,
    capabilityId: `0x${"c9".repeat(32)}`, expiresAt: 2_000_000_000
  });
  return { records: [{ capability, acceptedAt: 1_900_000_000_000, status: "active" }], issues: [] };
}

function services(open: AccountHandle): AppServices {
  return {
    guardianVault: { list: async () => [], inspect: async () => snapshot(open), put: async () => undefined, remove: async () => undefined },
    invitationLinks: {}, accounts: {}, publicClients: { forEndpoint: () => ({}) }, runtime: {}, pendingOperations: {},
    now: () => 1_900_000_000_000
  } as unknown as AppServices;
}

function view(request: Record<string, unknown>) {
  return {
    key: "k", recoveryId: `0x${"c1".repeat(32)}`, account: protectedAccount, chainId: 11_155_111,
    capabilityId: `0x${"c9".repeat(32)}`, threshold: 2, publishedApprovals: 1,
    alreadyPublishedByMe: false, expiresAt: 1_900_003_600, ...request
  };
}

async function renderAndCheck(open: AccountHandle) {
  render(
    <NetworkProvider>
      <AppServicesProvider services={services(open)}><GuardianWorkspace account={open} /></AppServicesProvider>
    </NetworkProvider>
  );
  const button = await screen.findByRole("button", { name: /check for recovery requests/iu });
  await userEvent.click(button);
}

test("a verified request is labelled as verified and offers a review action", async () => {
  discover.mockResolvedValue({
    requests: [view({ trust: "verified", request: { humanCode: "123456" } })],
    rolledBack: [], snapshots: {}
  });
  await renderAndCheck(guardianAccount());

  expect(await screen.findByText(/recovery request verified/iu)).toBeTruthy();
  expect(screen.getByText(/verified against chain/iu)).toBeTruthy();
  expect(screen.getByText("1 of 2")).toBeTruthy();
  expect(screen.getByRole("button", { name: /review request/iu })).toBeTruthy();
});

test("an unverified request is never presented as reviewable and shows why", async () => {
  discover.mockResolvedValue({
    requests: [view({ trust: "detected", issue: "This request does not match the account's current recovery state." })],
    rolledBack: [], snapshots: {}
  });
  await renderAndCheck(guardianAccount());

  expect(await screen.findByText(/possible recovery request/iu)).toBeTruthy();
  expect(screen.getByText(/^unverified$/iu)).toBeTruthy();
  expect(screen.getByText(/does not match the account's current recovery state/iu)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /review request/iu })).toBeNull();
});

test("a reorg rollback is announced rather than shown as a quietly smaller count", async () => {
  discover.mockResolvedValue({
    requests: [view({ trust: "verified", request: { humanCode: "123456" }, publishedApprovals: 1 })],
    rolledBack: [`0x${"1a".repeat(32)}`], snapshots: {}
  });
  await renderAndCheck(guardianAccount());

  const notice = await screen.findByText(/a published approval was rolled back/iu);
  expect(notice).toBeTruthy();
  expect(notice.closest("[role='status']")).toBeTruthy();
});

test("when discovery is unavailable the manual paste path is still offered", async () => {
  discover.mockResolvedValue({
    requests: [], rolledBack: [], snapshots: {},
    unavailable: "This deployment publishes no on-chain recovery discovery."
  });
  await renderAndCheck(guardianAccount());

  expect(await screen.findByText(/publishes no on-chain recovery discovery/iu)).toBeTruthy();
  // Losing discovery must never remove the provider-independent path. It is
  // folded away rather than removed: announcing costs a transaction, so many
  // requests are handed over privately and never appear on chain at all.
  expect(screen.getByText(/it was sent to me directly/iu)).toBeTruthy();
  expect(screen.getByRole("button", { name: /review pasted request/iu })).toBeTruthy();
});

test("the request list is reachable by keyboard and labelled for a screen reader", async () => {
  discover.mockResolvedValue({
    requests: [view({ trust: "verified", request: { humanCode: "123456" } })],
    rolledBack: [], snapshots: {}
  });
  await renderAndCheck(guardianAccount());

  const region = await screen.findByRole("region", { name: /requests for accounts you protect/iu });
  expect(region).toBeTruthy();

  const review = screen.getByRole("button", { name: /review request/iu });
  review.focus();
  expect(document.activeElement).toBe(review);
});
