import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { GuardianInviteLinks } from "../../src/features/recovery/GuardianInviteLinks.tsx";
import type { GuardianRoster } from "../../src/storage/guardianRoster.ts";

afterEach(cleanup);

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;

const services = (roster: GuardianRoster): AppServices => ({
  accounts: {}, guardianVault: {}, guardianRoster: roster, invitationLinks: {},
  publicClients: { forEndpoint: () => ({}) }, runtime: {}, pendingOperations: {},
  now: () => 1_900_000_000_000
} as unknown as AppServices);

const roster = (entries: readonly { id: string; label: string }[]): GuardianRoster => ({
  read: async () => ({ entries, version: 1, pending: null, corrupt: 0 }),
  write: async () => undefined
} as unknown as GuardianRoster);

const view = (store: GuardianRoster) => render(
  <NetworkProvider>
    <AppServicesProvider services={services(store)}>
      <GuardianInviteLinks account={ACCOUNT} chainId={11_155_111} />
    </AppServicesProvider>
  </NetworkProvider>
);

// Guardian identities are private and never published, so a device that does
// not hold the list genuinely cannot issue an invitation. Saying why is the
// difference between a missing feature and a recoverable situation.
test("a device without the guardian list says why it cannot invite, and what would fix it", async () => {
  view(roster([]));

  const reason = await screen.findByText(/does not hold the guardian list for this account/iu);
  expect(reason.textContent).toMatch(/never published/iu);
  expect(reason.textContent).toMatch(/encrypted backup/iu);
});

// A roster that cannot be read is a different situation from an empty one, and
// reporting them alike would send someone hunting for a backup they already
// have.
test("a roster that cannot be read is reported as unreadable, not as absent", async () => {
  view({ read: async () => { throw new Error("store unavailable"); }, write: async () => undefined } as unknown as GuardianRoster);

  const reason = await screen.findByText(/could not be read/iu);
  expect(reason.textContent).not.toMatch(/does not hold the guardian list/iu);
});

test("the guardians this device holds are offered by name", async () => {
  view(roster([{ id: "g1", label: "Ada" }, { id: "g2", label: "Bo" }]));

  await screen.findByText("Ada");
  await screen.findByText("Bo");
});
