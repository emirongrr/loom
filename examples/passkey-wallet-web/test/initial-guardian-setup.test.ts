import assert from "node:assert/strict";
import test from "node:test";
import { prepareInitialGuardianSetup } from "../src/features/onboarding/initialGuardianSetup.ts";

const VERIFIER = "0x1111111111111111111111111111111111111111";
const CODE_HASH = `0x${"33".repeat(32)}`;
const DEPLOYMENT = { recoveryModule: "0x2222222222222222222222222222222222222222", guardianVerifiers: { ecdsa: VERIFIER } } as never;
const ENTRY = { id: "guardian-1", label: "Alex", descriptor: { kind: "ecdsa", address: "0x4444444444444444444444444444444444444444", verifier: VERIFIER, verifierCodeHash: CODE_HASH } } as const;

test("initial guardian setup rechecks verifier code and commits fresh salts", async () => {
  let reads = 0;
  const prepared = await prepareInitialGuardianSetup({ entries: [ENTRY] as never, threshold: 1, deployment: DEPLOYMENT, async readVerifierCodeHash() { reads += 1; return CODE_HASH; }, randomBytes: length => new Uint8Array(length).fill(7) });
  assert.equal(reads, 1);
  assert.equal(prepared.set.threshold, 1);
  assert.equal(prepared.entries[0]?.descriptor.salt, `0x${"07".repeat(32)}`);
});

test("initial guardian setup rejects verifier substitution and runtime-code drift", async () => {
  await assert.rejects(prepareInitialGuardianSetup({ entries: [{ ...ENTRY, descriptor: { ...ENTRY.descriptor, verifier: "0x5555555555555555555555555555555555555555" } }] as never, threshold: 1, deployment: DEPLOYMENT, async readVerifierCodeHash() { return CODE_HASH; } }), /deployment's ECDSA guardian verifier/iu);
  await assert.rejects(prepareInitialGuardianSetup({ entries: [ENTRY] as never, threshold: 1, deployment: DEPLOYMENT, async readVerifierCodeHash() { return `0x${"66".repeat(32)}`; } }), /runtime code changed/iu);
});
