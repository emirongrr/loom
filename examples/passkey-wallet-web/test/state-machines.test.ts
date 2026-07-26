import assert from "node:assert/strict";
import test from "node:test";

import { guardianReducer } from "../src/features/guardians/reducer.ts";
import { authenticationCode, initialRecoveryState, recoveryReducer } from "../src/features/recovery/reducer.ts";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";

const invite = { version: 1 } as GuardianInviteV1;

test("recovery state machine enforces quorum, delay, expiry, and cancellation", () => {
  let state = recoveryReducer(initialRecoveryState, { type: "LOAD_ACCOUNT" });
  state = recoveryReducer(state, { type: "CREATE_PASSKEY" });
  state = recoveryReducer(state, { type: "COLLECT", have: 1, need: 2, authenticationCode: "amber birch cobalt drift" });
  assert.equal(recoveryReducer(state, { type: "READY", authenticationCode: "ignored" }).status, "collecting-approvals");

  state = recoveryReducer(state, { type: "COLLECT", have: 2, need: 2, authenticationCode: "amber birch cobalt drift" });
  state = recoveryReducer(state, { type: "READY", authenticationCode: "amber birch cobalt drift" });
  state = recoveryReducer(state, { type: "PROPOSING" });
  state = recoveryReducer(state, { type: "PROPOSED", readyAt: 20n, expiresAt: 30n });
  assert.equal(recoveryReducer(state, { type: "EXECUTE" }).status, "delay-active");
  assert.equal(recoveryReducer(state, { type: "TICK", now: 20n }).status, "ready-to-execute");
  assert.equal(recoveryReducer(state, { type: "TICK", now: 31n }).status, "expired");
  assert.equal(recoveryReducer(state, { type: "CANCEL" }).status, "cancelled");
});

test("authentication code is deterministic and rejects non-bytes32 input", () => {
  assert.equal(
    authenticationCode("0x000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f"),
    "0001-0203-0405-0607"
  );
  assert.throws(() => authenticationCode("0x12" as `0x${string}`), /bytes32/u);
});

test("guardian onboarding cannot skip acceptance or quorum", () => {
  const draft = { status: "draft" } as const;
  assert.equal(guardianReducer(draft, { type: "ACTIVE" }).status, "draft");
  const created = guardianReducer(draft, { type: "INVITE_CREATED", invite });
  assert.equal(guardianReducer(created, { type: "QUORUM", accepted: 2, threshold: 2 }).status, "invite-created");
  const accepted = guardianReducer(created, { type: "ACCEPTED" });
  assert.equal(guardianReducer(accepted, { type: "QUORUM", accepted: 1, threshold: 2 }).status, "accepted");
  const ready = guardianReducer(accepted, { type: "QUORUM", accepted: 2, threshold: 2 });
  assert.equal(ready.status, "ready-to-activate");
});
