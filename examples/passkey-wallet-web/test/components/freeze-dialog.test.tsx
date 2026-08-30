import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createGuardianInvite, createGuardianSet } from "@loom/sdk/recovery";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { NotificationsProvider } from "../../src/notifications/NotificationsContext.tsx";
import { FreezeDialog } from "../../src/features/guardians/FreezeDialog.tsx";
import type { WalletDeployment } from "../../src/features/onboarding/accountLifecycle.ts";
import type { AccountHandle } from "../../src/types.ts";

afterEach(cleanup);

const PROTECTED = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x7777777777777777777777777777777777777777";
const VERIFIER = "0x3333333333333333333333333333333333333333";

function guardianAccount(byte: string): AccountHandle {
  return {
    version: 1, kind: "created", id: `guardian-${byte}`, label: "Guardian wallet",
    account: `0x${byte.repeat(20)}`, chainId: 11_155_111, credentialId: `0x${byte}`,
    publicKey: { x: `0x${byte.repeat(32)}`, y: `0x${(byte === "aa" ? "bb" : "cc").repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"33".repeat(20)}`
  };
}

const capabilityFor = (handle: AccountHandle) => {
  const set = createGuardianSet({
    guardians: [{
      kind: "p256", publicKey: handle.publicKey, credentialId: handle.credentialId,
      verifier: VERIFIER, verifierCodeHash: `0x${"a1".repeat(32)}`, salt: `0x${"32".repeat(32)}`
    }],
    threshold: 1
  });
  return createGuardianInvite({
    set, guardianLeaf: set.guardians[0]!.leaf, chainId: 11_155_111, account: PROTECTED,
    accountAlias: "Protected account", issuerLabel: "Owner", guardianSetVersion: 1,
    configVersion: 4, capabilityId: `0x${"44".repeat(32)}`, expiresAt: 2_000_000_000
  });
};

const deployment = {
  chainId: 11_155_111, recoveryModule: MANAGER, policyHook: `0x${"55".repeat(20)}`
} as unknown as WalletDeployment;

/** Never resolves, holding the dialog in its first state so it can be read. */
const services = {
  accounts: {}, guardianVault: {}, guardianRoster: {}, invitationLinks: {},
  publicClients: {
    forEndpoint: () => ({
      readContract: () => new Promise(() => undefined),
      request: () => new Promise(() => undefined)
    })
  },
  runtime: {}, pendingOperations: {}, now: () => 1_900_000_000_000
} as unknown as AppServices;

const view = (handle: AccountHandle) => render(
  <NetworkProvider>
    <NotificationsProvider>
      <AppServicesProvider services={services}>
        <FreezeDialog
          capability={capabilityFor(handle)}
          deployment={deployment}
          guardianAccount={handle}
          onClose={() => undefined}
        />
      </AppServicesProvider>
    </NotificationsProvider>
  </NetworkProvider>
);

// Freezing is the one guardian action that takes effect immediately, without a
// threshold or a delay. What it does and does not do has to be on the screen
// before the button is, not discovered afterwards.
test("the dialog names the account it would freeze", () => {
  view(guardianAccount("aa"));
  expect(screen.getByText(/0x1111/u)).toBeTruthy();
  expect(screen.getByRole("heading", { name: /Emergency freeze/u })).toBeTruthy();
});

// A guardian's commitment and proof are private until they act. Freezing
// publishes both, and that is not recoverable, so it is stated as a cost rather
// than left to be discovered from the chain.
test("the dialog waits on live state rather than offering the action first", () => {
  view(guardianAccount("aa"));
  expect(screen.getByText(/Re-reading the account's live guardian state/iu)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Confirm freeze with passkey/u })).toBeNull();
});
