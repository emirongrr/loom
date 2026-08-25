import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { NotificationsProvider } from "../../src/notifications/NotificationsContext.tsx";
import { GuardianManager } from "../../src/features/security/GuardianManager.tsx";
import { buildGuardianDescriptor, createRosterEntry, planGuardianChange, withFreshSalts } from "../../src/features/security/guardianPlan.ts";
import type { GuardianRoster } from "../../src/storage/guardianRoster.ts";
import type { OnChainGuardians } from "../../src/features/security/guardianStatus.ts";
import type { AccountHandle } from "../../src/types.ts";

afterEach(cleanup);

const OWNER = "0x1111111111111111111111111111111111111111";
const ALICE = "0x00000000000000000000000000000000000000A1";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const CODE_HASH = `0x${"a1".repeat(32)}` as const;

function account(): AccountHandle {
  return {
    version: 1, kind: "created", id: "wallet-1", label: "My wallet", account: OWNER,
    chainId: 11_155_111, credentialId: "0x01",
    publicKey: { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"33".repeat(20)}`
  };
}

const BO = "0x00000000000000000000000000000000000000b2";

const guardian = (label: string, address: string = ALICE) => createRosterEntry({
  label,
  descriptor: buildGuardianDescriptor({ kind: "ecdsa", value: address, verifier: VERIFIER, verifierCodeHash: CODE_HASH }),
  guardianAccount: address as `0x${string}`
});

/** Deterministic, so the root a test computes is the one the screen rebuilds. */
const seeded = (seed: number) => {
  let counter = seed;
  return (length: number) => Uint8Array.from({ length }, () => (counter = (counter * 31 + 7) % 251));
};

/** Committed entries carry their salts; without them no root can match. */
const committed = (labels: readonly (readonly [string, string])[]) =>
  withFreshSalts(labels.map(([label, address]) => guardian(label, address)), seeded(19));

function roster(entries: readonly ReturnType<typeof guardian>[]): { store: GuardianRoster; writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    store: {
      read: async () => ({ entries, version: 1, pending: null, corrupt: 0 }),
      write: async (_id, input) => { writes.push(input); }
    } as unknown as GuardianRoster
  };
}

function services(store: GuardianRoster): AppServices {
  return {
    accounts: {}, guardianVault: {}, guardianRoster: store, invitationLinks: {},
    publicClients: { forEndpoint: () => ({ getBlock: async () => ({ timestamp: 0n, number: 0n }) }) },
    runtime: {}, pendingOperations: {}, now: () => 1_900_000_000_000
  } as unknown as AppServices;
}

const view = (store: GuardianRoster, onChain: OnChainGuardians | null) => render(
  <NetworkProvider>
    <NotificationsProvider>
      <AppServicesProvider services={services(store)}>
        <GuardianManager account={account()} deployment={null} onChain={onChain} onChanged={() => undefined} />
      </AppServicesProvider>
    </NotificationsProvider>
  </NetworkProvider>
);

const onChainFor = (entries: readonly ReturnType<typeof guardian>[], threshold: number): OnChainGuardians => ({
  root: planGuardianChange({ current: [], next: entries, threshold }).set.root,
  threshold,
  recoveryConfigured: true,
  configVersion: 1n
});

test("a guardian is listed by the wallet it was added from, not by its kind", async () => {
  const entries = committed([["Ada", ALICE]]);
  view(roster(entries).store, onChainFor(entries, 1));

  // "Dedicated passkey" is true of every passkey guardian and so tells two of
  // them apart from nothing. The address is what identifies one.
  await screen.findByText("Ada");
  await screen.findByText(/0x00000000…0000A1/u);
});

// Adding and removing edit a draft; only a scheduled change reaches the chain.
// Without saying so, "Remove" reads as done -- and the guardian is simply back
// on the next visit, which looks like the wallet forgetting.
test("an unsaved edit says it is unsaved before it can be lost", async () => {
  const entries = committed([["Ada", ALICE], ["Bo", BO]]);
  view(roster(entries).store, onChainFor(entries, 2));

  await screen.findByText("Ada");
  expect(screen.queryByText(/Not saved yet/iu)).toBeNull();

  await userEvent.click(await screen.findByRole("button", { name: /^Ada/u }));
  await userEvent.click(await screen.findByRole("button", { name: /^Remove$/u }));

  await screen.findByText(/Not saved yet/iu);
  await screen.findByText(/Leaving this page discards these edits/iu);
});

test("a removed guardian is gone from the draft but nothing is written to storage", async () => {
  const entries = committed([["Ada", ALICE], ["Bo", BO]]);
  const { store, writes } = roster(entries);
  view(store, onChainFor(entries, 2));

  await screen.findByText("Ada");
  await userEvent.click(await screen.findByRole("button", { name: /^Ada/u }));
  await userEvent.click(await screen.findByRole("button", { name: /^Remove$/u }));

  await waitFor(() => { expect(screen.queryByText("Ada")).toBeNull(); });
  // The chain is the record. A draft that wrote itself down would survive a
  // reload as though it had been committed.
  expect(writes).toEqual([]);
});

test("discarding an edit restores the committed list", async () => {
  const entries = committed([["Ada", ALICE], ["Bo", BO]]);
  view(roster(entries).store, onChainFor(entries, 2));

  await screen.findByText("Ada");
  await userEvent.click(await screen.findByRole("button", { name: /^Ada/u }));
  await userEvent.click(await screen.findByRole("button", { name: /^Remove$/u }));
  await waitFor(() => { expect(screen.queryByText("Ada")).toBeNull(); });

  await userEvent.click(await screen.findByRole("button", { name: /^Discard$/u }));
  await screen.findByText("Ada");
  // Discard exists only while there is something unsaved, so its absence is the
  // clearest statement that the draft matches what the chain holds.
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^Discard$/u })).toBeNull();
  });
});

// An account whose local list does not rebuild the on-chain root must be told,
// not shown a list it cannot act on as though everything agreed.
test("a local list that does not rebuild the account's root is reported, not presented as the truth", async () => {
  const entries = committed([["Ada", ALICE]]);
  const foreign: OnChainGuardians = {
    root: `0x${"99".repeat(32)}`, threshold: 1, recoveryConfigured: true, configVersion: 1n
  };
  view(roster(entries).store, foreign);

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^Review changes$/u })).toBeNull();
  });
});
