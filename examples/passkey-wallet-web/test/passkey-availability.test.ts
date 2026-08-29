import assert from "node:assert/strict";
import test from "node:test";
import { classifyPasskeyAvailability, dismissPasskeyGuidance, passkeyGuidanceDismissed } from "../src/features/security/passkeyAvailability.ts";

const observation = (backupEligible: boolean, backedUp: boolean) => ({
  backupEligible, backedUp, observedAt: 1, source: "assertion" as const
});

test("backup flags map to provider-neutral availability states", () => {
  assert.equal(classifyPasskeyAvailability(), "unknown");
  assert.equal(classifyPasskeyAvailability(observation(false, false)), "authenticator-bound");
  assert.equal(classifyPasskeyAvailability(observation(true, false)), "sync-pending");
  assert.equal(classifyPasskeyAvailability(observation(true, true)), "backed-up");
});

test("recommendation dismissal is scoped to one account and tolerates damaged state", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  } as Storage;
  assert.equal(passkeyGuidanceDismissed("wallet-a", storage), false);
  dismissPasskeyGuidance("wallet-a", storage);
  assert.equal(passkeyGuidanceDismissed("wallet-a", storage), true);
  assert.equal(passkeyGuidanceDismissed("wallet-b", storage), false);
  values.set("loom.wallet.passkey-guidance.v1", "not-json");
  assert.equal(passkeyGuidanceDismissed("wallet-a", storage), false);
});
