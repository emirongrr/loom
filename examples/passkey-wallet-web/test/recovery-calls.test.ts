import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData } from "viem";
import { RecoveryIntentBoardAbi, RecoveryManagerAbi } from "@loom/core/abi";
import {
  announceRecovery, cancelWithAccountAndGuardians, cancelWithGuardians,
  oldValidatorsHash, publishApproval, publishCancellation
} from "../src/features/recovery/recoveryCalls.ts";

const BOARD = "0x4c0a39a24f84abcb61648e415eecd5ad87ed23bf" as const;
const MANAGER = "0x9569cae60f775341c0f6c8f70170d85adbfab5f8" as const;
const ACCOUNT = "0x8A2f1487c2B30c371c0Cd2862d3B5FD05981aFc1" as const;

const approval = (mark: string) => ({
  verifier: `0x${mark.repeat(20)}`,
  keyCommitment: `0x${mark.repeat(32)}`,
  salt: `0x${mark.repeat(32)}`,
  signature: `0x${mark.repeat(65)}`,
  proof: [`0x${mark.repeat(32)}`]
}) as never;

const decodeBoard = (data: `0x${string}`) => decodeFunctionData({ abi: RecoveryIntentBoardAbi, data });
const decodeManager = (data: `0x${string}`) => decodeFunctionData({ abi: RecoveryManagerAbi, data });

test("an announcement is addressed to the board and names the account", () => {
  const call = announceRecovery({
    board: BOARD, account: ACCOUNT, recoveryManager: MANAGER,
    oldValidatorsHash: `0x${"11".repeat(32)}`, newValidator: `0x${"22".repeat(20)}`,
    initDataHash: `0x${"33".repeat(32)}`, newGuardianRoot: `0x${"44".repeat(32)}`,
    newGuardianThreshold: 2, expiresAt: 2_000_000_000
  });
  assert.equal(call.to, BOARD);
  const decoded = decodeBoard(call.data);
  assert.equal(decoded.functionName, "announce");
  assert.equal(decoded.args?.[0], ACCOUNT);
});

test("publishing an approval carries exactly one guardian, and no leaf", () => {
  const call = publishApproval({
    board: BOARD, account: ACCOUNT, recoveryManager: MANAGER,
    oldValidatorsHash: `0x${"11".repeat(32)}`, newValidator: `0x${"22".repeat(20)}`,
    initDataHash: `0x${"33".repeat(32)}`, newGuardianRoot: `0x${"44".repeat(32)}`,
    newGuardianThreshold: 2, approval: approval("aa")
  });
  const decoded = decodeBoard(call.data);
  assert.equal(decoded.functionName, "publishApproval");
  const approvals = decoded.args?.[7] as readonly Record<string, unknown>[];
  assert.equal(approvals.length, 1);
  assert.ok(!("leaf" in approvals[0]!), "the leaf is derived on chain and must not be sent");
});

// A cancellation names no recovery of its own: the board reads the pending
// record from the manager and derives the identity from it.
test("publishing a cancellation sends only the account, manager, and signature", () => {
  const call = publishCancellation({ board: BOARD, account: ACCOUNT, recoveryManager: MANAGER, approval: approval("bb") });
  const decoded = decodeBoard(call.data);
  assert.equal(decoded.functionName, "publishCancellation");
  assert.equal(decoded.args?.length, 3);
});

test("the two cancellation routes are different calls to the manager", () => {
  const withAccount = cancelWithAccountAndGuardians({ recoveryManager: MANAGER, account: ACCOUNT, approvals: [approval("cc")] });
  const guardiansOnly = cancelWithGuardians({ recoveryManager: MANAGER, account: ACCOUNT, approvals: [approval("cc")] });
  assert.equal(withAccount.to, MANAGER);
  assert.equal(decodeManager(withAccount.data).functionName, "cancelRecoveryWithAccountAndGuardians");
  assert.equal(decodeManager(guardiansOnly.data).functionName, "cancelRecoveryWithGuardians");
  assert.notEqual(withAccount.data, guardiansOnly.data);
});

// GuardianVerificationLib walks the approvals expecting strictly increasing
// leaves and refuses the bundle otherwise. A screen must not be able to submit
// a bundle the chain rejects for an ordering the screen never chose.
test("a bundle is ordered before it is sent, whatever order it was collected in", () => {
  const ascending = cancelWithGuardians({ recoveryManager: MANAGER, account: ACCOUNT, approvals: [approval("11"), approval("99")] });
  const descending = cancelWithGuardians({ recoveryManager: MANAGER, account: ACCOUNT, approvals: [approval("99"), approval("11")] });
  assert.equal(ascending.data, descending.data);
});

test("the validators hash is stable and depends on the set", () => {
  const one = oldValidatorsHash([`0x${"11".repeat(20)}`]);
  const same = oldValidatorsHash([`0x${"11".repeat(20)}`]);
  const other = oldValidatorsHash([`0x${"22".repeat(20)}`]);
  assert.equal(one, same);
  assert.notEqual(one, other);
});
