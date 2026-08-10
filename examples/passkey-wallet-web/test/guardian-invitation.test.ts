import assert from "node:assert/strict";
import test from "node:test";

import { createGuardianLeaf, validateGuardianInvite } from "@loom/sdk/recovery";
import { buildGuardianDescriptor, planGuardianChange, withFreshSalts, type RosterEntry } from "../src/features/security/guardianPlan.ts";
import { createActiveGuardianInvitation } from "../src/features/security/guardianInvitation.ts";
import { createGuardianInviteQr } from "../src/features/security/guardianInviteQr.ts";
import { createEncryptedLinkTransport } from "../src/transports/invitations.ts";

const ACCOUNT = "0xe5CDbB47df6AD1319a5BC124D9233e05c89C9eD1";
const GUARDIAN = "0x73E1Fc60aB8b5F31a36a640d1f8035E99cE8192C";
const OTHER = "0x8659EAa644CC30Dac6243d69612329BF636F133F";
const VERIFIER = "0x7f3FEcc48C9737473a56aBA46fb81ff558Dc3E4b";
const CODE_HASH = `0x${"ab".repeat(32)}` as const;

function entry(id: string, address: string): RosterEntry {
  return {
    id,
    label: id,
    descriptor: buildGuardianDescriptor({ kind: "ecdsa", value: address, verifier: VERIFIER, verifierCodeHash: CODE_HASH })
  };
}

function fixture() {
  const entries = withFreshSalts([entry("smart", GUARDIAN), entry("eoa", OTHER)], length => new Uint8Array(length).fill(7));
  // Give the second leaf a distinct salt, as a real roster always does.
  const distinct = entries.map((item, index) => index === 0 ? item : ({
    ...item,
    descriptor: { ...item.descriptor, salt: `0x${"08".repeat(32)}` as const }
  }));
  const set = planGuardianChange({ current: [], next: distinct, threshold: 2 }).set;
  return { entries: distinct, set };
}

test("creates an individualized invite for a guardian in the active on-chain set", () => {
  const { entries, set } = fixture();
  const invite = createActiveGuardianInvitation({
    entries,
    guardianId: "smart",
    setVersion: 12,
    onChain: { root: set.root, threshold: 2, recoveryConfigured: true, configVersion: 1n },
    chainId: 11_155_111,
    account: ACCOUNT,
    capabilityId: `0x${"cd".repeat(32)}`,
    expiresAt: 2_000_000_000
  });

  assert.equal(invite.guardianRoot, set.root);
  assert.equal(invite.accountAlias, "Protected account");
  assert.equal(invite.issuerLabel, "Account owner");
  assert.equal(JSON.stringify(invite).includes("Main wallet"), false);
  assert.equal(invite.guardian.leaf, createGuardianLeaf(entries.find(entry => entry.id === "smart")!.descriptor));
  assert.equal(invite.guardianCount, 2);
  assert.doesNotThrow(() => validateGuardianInvite(invite, {
    chainId: 11_155_111,
    account: ACCOUNT,
    guardianRoot: set.root,
    configVersion: 1n,
    now: 1_900_000_000
  }));
});

test("refuses to mint an invite when the local roster does not match live chain authority", () => {
  const { entries } = fixture();
  assert.throws(() => createActiveGuardianInvitation({
    entries,
    guardianId: "smart",
    setVersion: 12,
    onChain: { root: `0x${"ff".repeat(32)}`, threshold: 2, recoveryConfigured: true, configVersion: 1n },
    chainId: 11_155_111,
    account: ACCOUNT,
    capabilityId: `0x${"cd".repeat(32)}`,
    expiresAt: 2_000_000_000
  }), /does not match the active guardian root/);
});

test("refuses to mint an invite while recovery authority is not installed", () => {
  const { entries, set } = fixture();
  assert.throws(() => createActiveGuardianInvitation({
    entries,
    guardianId: "smart",
    setVersion: 12,
    onChain: { root: set.root, threshold: 2, recoveryConfigured: false, configVersion: 1n },
    chainId: 11_155_111,
    account: ACCOUNT,
    capabilityId: `0x${"cd".repeat(32)}`,
    expiresAt: 2_000_000_000
  }), /recovery module is not active/);
});

test("the encrypted invitation for a realistic guardian set fits in one local QR code", async () => {
  const { entries, set } = fixture();
  const expiresAt = 2_000_000_000;
  const invite = createActiveGuardianInvitation({
    entries,
    guardianId: "smart",
    setVersion: 12,
    onChain: { root: set.root, threshold: 2, recoveryConfigured: true, configVersion: 1n },
    chainId: 11_155_111,
    account: ACCOUNT,
    capabilityId: `0x${"cd".repeat(32)}`,
    expiresAt
  });
  const delivered = await createEncryptedLinkTransport<typeof invite>({ origin: "https://wallet.example" }).deliver(invite, { expiresAt });
  const qr = createGuardianInviteQr(delivered.value);

  assert.ok(qr);
  assert.ok(qr.size > 0);
  assert.ok(qr.path.length > 0);
});
