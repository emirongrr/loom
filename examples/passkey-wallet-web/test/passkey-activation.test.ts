import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

/**
 * `navigator.credentials.get` needs the transient activation the click granted.
 * Awaiting anything ahead of it spends that activation, and the browser then
 * rejects the call without ever showing its picker -- which looks exactly like
 * the button doing nothing.
 *
 * Checked as source order because the failure is an ordering mistake that
 * type-checks, passes every other test, and only shows up in a real browser.
 */
test("finding a wallet asks for the passkey before it awaits anything else", () => {
  const flow = app.slice(app.indexOf("const findByPasskey = async"));
  const body = flow.slice(0, flow.indexOf("\n  };"));
  const firstAwait = body.indexOf("await ");
  const passkeyRequest = body.indexOf("await assertAnyPasskey()");

  assert.notEqual(passkeyRequest, -1, "the flow no longer asks for a passkey");
  assert.equal(
    firstAwait,
    passkeyRequest,
    "something is awaited before the passkey is requested, which spends the click's activation"
  );
});
