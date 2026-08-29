import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createGuardianInvite, createGuardianSet, createRecoveryId, createRecoveryRequest } from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { AppServicesProvider, type AppServices } from "../../src/app/AppServices.tsx";
import { NetworkProvider } from "../../src/config/NetworkContext.tsx";
import { RecoveryApprovalDialog } from "../../src/features/guardians/RecoveryApprovalDialog.tsx";
import type { WalletDeployment } from "../../src/features/onboarding/accountLifecycle.ts";
import type { AccountHandle } from "../../src/types.ts";

afterEach(cleanup);

const PROTECTED = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x7777777777777777777777777777777777777777";
const VERIFIER = "0x3333333333333333333333333333333333333333";

/** A guardian identified by its own P-256 key, as a Loom guardian wallet is. */
function guardianAccount(byte: string): AccountHandle {
  return {
    version: 1, kind: "created", id: `guardian-${byte}`, label: "Guardian wallet",
    account: `0x${byte.repeat(20)}`, chainId: 11_155_111, credentialId: `0x${byte}`,
    publicKey: { x: `0x${byte.repeat(32)}`, y: `0x${(byte === "aa" ? "bb" : "cc").repeat(32)}` },
    rpId: "localhost", origin: "http://localhost:5174", validator: `0x${"33".repeat(20)}`
  };
}

function capabilityFor(handle: AccountHandle) {
  const set = createGuardianSet({
    guardians: [{
      kind: "p256",
      publicKey: handle.publicKey,
      credentialId: handle.credentialId,
      verifier: VERIFIER,
      verifierCodeHash: `0x${"a1".repeat(32)}`,
      salt: `0x${"32".repeat(32)}`
    }],
    threshold: 1
  });
  return createGuardianInvite({
    set, guardianLeaf: set.guardians[0]!.leaf, chainId: 11_155_111, account: PROTECTED,
    accountAlias: "Protected account", issuerLabel: "Owner", guardianSetVersion: 1,
    configVersion: 4, capabilityId: `0x${"44".repeat(32)}`, expiresAt: 2_000_000_000
  });
}

const validators = ["0x5555555555555555555555555555555555555555"] as const;
const identity = {
  account: PROTECTED,
  oldValidatorsHash: keccak256(encodeAbiParameters(parseAbiParameters("address[] oldValidators"), [validators])),
  newValidator: "0x6666666666666666666666666666666666666666",
  initDataHash: `0x${"67".repeat(32)}`, newGuardianRoot: `0x${"68".repeat(32)}`,
  newGuardianThreshold: 1, configVersion: 4, nonce: 0
} as const;

const request = createRecoveryRequest({
  requestId: createRecoveryId(identity), chainId: 11_155_111, account: PROTECTED,
  recoveryManager: MANAGER, guardianRoot: capabilityFor(guardianAccount("aa")).guardianRoot,
  guardianThreshold: 1, configVersion: "4", nonce: "0",
  newValidator: identity.newValidator, initDataHash: identity.initDataHash,
  newGuardianRoot: identity.newGuardianRoot, newGuardianThreshold: 1,
  createdAt: 1_900_000_000, expiresAt: 1_900_086_400
});

const deployment = {
  chainId: 11_155_111, recoveryModule: MANAGER, recoveryIntentBoard: `0x${"88".repeat(20)}`,
  recoveryValidatorProvisioner: { validatorRuntimeCodeHash: `0x${"99".repeat(32)}` }
} as unknown as WalletDeployment;

const services = {
  accounts: {}, guardianVault: {}, guardianRoster: {}, invitationLinks: {},
  publicClients: { forEndpoint: () => ({}) }, runtime: {}, pendingOperations: {},
  now: () => 1_900_000_000_000
} as unknown as AppServices;

const view = (handle: AccountHandle, capability: ReturnType<typeof capabilityFor>, published = false) => render(
  <NetworkProvider>
    <AppServicesProvider services={services}>
      <RecoveryApprovalDialog
        request={request}
        capability={capability}
        deployment={deployment}
        guardianAccount={handle}
        alreadyPublished={published}
        onClose={() => undefined}
      />
    </AppServicesProvider>
  </NetworkProvider>
);

// The human code is the only channel-independent way to tell the guardian that
// the request in front of them is the one the recovering person described.
test("the request states the account, the new validator, and the code to compare", () => {
  const handle = guardianAccount("aa");
  view(handle, capabilityFor(handle));

  expect(screen.getByText(new RegExp(PROTECTED, "iu"))).toBeTruthy();
  expect(screen.getByText(new RegExp(identity.newValidator, "iu"))).toBeTruthy();
  expect(screen.getAllByText(new RegExp(request.humanCode, "u")).length).toBeGreaterThan(0);
  expect(screen.getByText(/independent channel/iu)).toBeTruthy();
});

// A capability whose key commitment is not this wallet's key belongs to someone
// else. Approving would produce a signature that matches no leaf, so the screen
// has to say why rather than letting the guardian try.
test("a capability for a different wallet cannot approve, and says so", () => {
  const other = guardianAccount("dd");
  view(other, capabilityFor(guardianAccount("aa")));

  expect(screen.getByText(/not a direct P-256 guardian for the open Loom wallet/iu)).toBeTruthy();
});

test("a capability matching the open wallet does not show that refusal", () => {
  const handle = guardianAccount("aa");
  view(handle, capabilityFor(handle));

  expect(screen.queryByText(/not a direct P-256 guardian for the open Loom wallet/iu)).toBeNull();
});

// Publishing twice wastes gas and tells the reader nothing new; the screen says
// the approval is already on chain rather than offering it again silently.
test("an approval already on chain is stated", () => {
  const handle = guardianAccount("aa");
  view(handle, capabilityFor(handle), true);

  expect(screen.getByText(/already published an approval for this request on chain/iu)).toBeTruthy();
});
