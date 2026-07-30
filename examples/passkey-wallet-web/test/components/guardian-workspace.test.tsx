import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { createGuardianInvite, createGuardianSet } from "@loom/sdk/recovery";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { GuardianWorkspace } from "../../src/features/guardians/GuardianWorkspace.tsx";
import type { GuardianVaultSnapshot } from "../../src/storage/guardianVault.ts";
import type { AccountHandle } from "../../src/types.ts";

function account(id: string, byte: string): AccountHandle {
  return {
    version: 1,
    kind: "recovered",
    id,
    label: id,
    account: `0x${byte.repeat(20)}`,
    chainId: 11_155_111,
    credentialId: `0x${byte}`,
    publicKey: { x: `0x${byte.repeat(32)}`, y: `0x${byte.repeat(32)}` },
    rpId: "localhost",
    origin: "http://localhost:5174",
    validator: `0x${"33".repeat(20)}`
  };
}

function snapshot(alias: string, accountAddress: `0x${string}`, capabilityByte: string, guardianAccount: AccountHandle): GuardianVaultSnapshot {
  const set = createGuardianSet({
    guardians: [{
      kind: "p256",
      publicKey: guardianAccount.publicKey,
      credentialId: guardianAccount.credentialId,
      verifier: "0x3333333333333333333333333333333333333333",
      verifierCodeHash: `0x${"a1".repeat(32)}`,
      salt: `0x${capabilityByte.repeat(32)}`
    }],
    threshold: 1
  });
  const capability = createGuardianInvite({
    set,
    guardianLeaf: set.guardians[0].leaf,
    chainId: 11_155_111,
    account: accountAddress,
    accountAlias: alias,
    issuerLabel: "Account owner",
    guardianSetVersion: 1,
    configVersion: 1n,
    capabilityId: `0x${capabilityByte.repeat(32)}`,
    expiresAt: 2_000_000_000
  });
  return {
    records: [{ capability, acceptedAt: 1_900_000_000_000, status: "active" }],
    issues: []
  };
}

test("switching wallets clears the previous guardian relationships before loading the next scope", async () => {
  const first = account("wallet-a", "11");
  const second = account("wallet-b", "22");
  const firstProtected = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const secondProtected = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const firstSnapshot = snapshot("Protected A", firstProtected, "a1", first);
  const secondSnapshot = snapshot("Protected B", secondProtected, "b1", second);
  let resolveSecond!: (value: GuardianVaultSnapshot) => void;
  const pendingSecond = new Promise<GuardianVaultSnapshot>(resolve => { resolveSecond = resolve; });
  const services = {
    guardianVault: {
      list: async () => [],
      inspect: async (open: AccountHandle) => open.id === first.id ? firstSnapshot : pendingSecond,
      put: async () => undefined,
      remove: async () => undefined
    },
    invitationLinks: {},
    accounts: {},
    publicClients: {},
    runtime: {},
    pendingOperations: {},
    now: () => 1_900_000_000_000
  } as AppServices;

  const view = render(
    <AppServicesProvider services={services}><GuardianWorkspace account={first} /></AppServicesProvider>
  );
  await screen.findByText(/^0xaaaa…aaaa$/iu);
  expect(screen.queryByText("Protected A")).toBeNull();

  view.rerender(
    <AppServicesProvider services={services}><GuardianWorkspace account={second} /></AppServicesProvider>
  );
  await waitFor(() => { expect(screen.queryByText(/^0xaaaa…aaaa$/iu)).toBeNull(); });

  await act(async () => { resolveSecond(secondSnapshot); });
  await screen.findByText(/^0xbbbb…bbbb$/iu);
  expect(screen.queryByText(/^0xaaaa…aaaa$/iu)).toBeNull();
  expect(screen.queryByText("Protected B")).toBeNull();
});
