import test from "node:test";
import assert from "node:assert/strict";
import { runVirtualWebAuthnFixture } from "./virtual-runner.mjs";

test("virtual WebAuthn fixture runner emits validator-compatible evidence", async () => {
  const result = await runVirtualWebAuthnFixture();
  assert.equal(result.fixtureCount, 1);
  assert.equal(result.incompleteCount, 6);
});
