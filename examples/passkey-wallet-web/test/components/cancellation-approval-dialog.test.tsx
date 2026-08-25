import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createCancelRequest, createGuardianInvite, createGuardianSet } from "@loom/sdk/recovery";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { CancellationApprovalDialog } from "../../src/features/guardians/CancellationApprovalDialog.tsx";
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

function capabilityFor(handle: AccountHandle, threshold: number) {
  const set = createGuardianSet({
    guardians: [{
      kind: "p256", publicKey: handle.publicKey, credentialId: handle.credentialId,
      verifier: VERIFIER, verifierCodeHash: `0x${"a1".repeat(32)}`, salt: `0x${"32".repeat(32)}`
    }],
    threshold: 1
  });
  return {
    set,
    capability: createGuardianInvite({
      set, guardianLeaf: set.guardians[0]!.leaf, chainId: 11_155_111, account: PROTECTED,
      accountAlias: "Protected account", issuerLabel: "Owner", guardianSetVersion: 1,
      configVersion: 4, capabilityId: `0x${"44".repeat(32)}`, expiresAt: 2_000_000_000,
      threshold
    })
  };
}

const requestFor = (root: `0x${string}`, threshold: number) => createCancelRequest({
  recoveryId: `0x${"5a".repeat(32)}`, chainId: 11_155_111, account: PROTECTED,
  recoveryManager: MANAGER, guardianRoot: root, guardianThreshold: threshold,
  configVersion: "4", nonce: "0", createdAt: 1_900_000_000, expiresAt: 1_900_086_400
});

const deployment = {
  chainId: 11_155_111, recoveryModule: MANAGER, recoveryIntentBoard: `0x${"88".repeat(20)}`
} as unknown as WalletDeployment;

const services = {
  accounts: {}, guardianVault: {}, guardianRoster: {}, invitationLinks: {},
  publicClients: { forEndpoint: () => ({ getCode: async () => "0x" }) },
  runtime: {}, pendingOperations: {}, now: () => 1_900_000_000_000
} as unknown as AppServices;

function view(handle: AccountHandle, threshold: number, capabilityHandle = handle) {
  const { set, capability } = capabilityFor(capabilityHandle, threshold);
  return render(
    <NetworkProvider>
      <AppServicesProvider services={services}>
        <CancellationApprovalDialog
          request={requestFor(set.root, threshold)}
          capability={capability}
          deployment={deployment}
          guardianAccount={handle}
          onClose={() => undefined}
        />
      </AppServicesProvider>
    </NetworkProvider>
  );
}

// Cancelling is the opposite of approving, and a guardian arriving from an
// approval flow must not read one screen as the other.
test("the screen states that this stops a recovery rather than helping one", () => {
  view(guardianAccount("aa"), 2);

  expect(screen.getByText(/This is the opposite of approving a recovery/iu)).toBeTruthy();
  expect(screen.getByText(/strands the owner/iu)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Sign to stop this recovery/iu }).textContent).toBeTruthy();
});

// One person cannot cancel alone: if they could, anyone holding a stolen key
// could block the guardians trying to take the account back.
test("the quorum is stated so a lone signature is not mistaken for enough", () => {
  view(guardianAccount("aa"), 3);

  expect(screen.getByText(/Your signature alone stops nothing/iu)).toBeTruthy();
  expect(screen.getByText(/2 guardians/u)).toBeTruthy();
});

test("a one-of-one account still says the account itself is not required", () => {
  view(guardianAccount("aa"), 1);

  expect(screen.getByText(/1 guardian, with or without the account/iu)).toBeTruthy();
});

// A capability whose key is not this wallet's belongs to someone else; signing
// would produce something that matches no leaf in the account's root.
test("a capability for another wallet cannot sign, and the button is withheld", () => {
  view(guardianAccount("dd"), 2, guardianAccount("aa"));

  expect(screen.getByText(/not a direct P-256 guardian for the open Loom wallet/iu)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Sign to stop this recovery/iu })).toBeNull();
});
