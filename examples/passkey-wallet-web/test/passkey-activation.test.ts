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

const lifecycle = readFileSync(new URL("../src/features/onboarding/accountLifecycle.ts", import.meta.url), "utf8");
const webauthn = readFileSync(new URL("../src/features/wallet/webauthn.ts", import.meta.url), "utf8");

/**
 * The chain keeps no index from a key back to its account, so without something
 * naming it the only way to learn which account a passkey opens is to collect
 * every key ever published and test the signature against each. WebAuthn hands
 * back whatever registration wrote into the credential, and that field was
 * sixteen random bytes.
 */
test("a passkey registered against a known account carries it", () => {
  const registration = lifecycle.slice(
    lifecycle.indexOf("user: {"),
    lifecycle.indexOf("pubKeyCredParams")
  );
  assert.match(registration, /id: account \?/u,
    "an account known at registration should be written into the credential");
  assert.match(registration, /crypto\.getRandomValues/u,
    "a wallet being created has no address yet and must keep random bytes");
});

test("an assertion returns the account only when the handle is an address", () => {
  assert.match(webauthn, /handle\.byteLength === 20/u,
    "a handle of any other length was written by something else and names nothing");
});
