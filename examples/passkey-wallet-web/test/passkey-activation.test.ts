import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const lifecycle = readFileSync(new URL("../src/features/onboarding/accountLifecycle.ts", import.meta.url), "utf8");
const webauthn = readFileSync(new URL("../src/features/wallet/webauthn.ts", import.meta.url), "utf8");
const discovery = readFileSync(new URL("../../../packages/sdk/src/accountDiscovery.ts", import.meta.url), "utf8");

test("finding a wallet asks for the passkey before it awaits anything else", () => {
  const flow = app.slice(app.indexOf("const findByPasskey = async"));
  const body = flow.slice(0, flow.indexOf("\n  };"));
  assert.equal(body.indexOf("await "), body.indexOf("await assertAnyPasskey()"));
});

test("every new credential carries the stable chain, factory, and account handle", () => {
  const registration = lifecycle.slice(lifecycle.indexOf("user: {"), lifecycle.indexOf("pubKeyCredParams"));
  assert.match(registration, /id: ownedBuffer\(userId\)/u);
  assert.match(lifecycle, /encodeAccountUserHandle\(chainId, factory, accountHandle\)/u);
  assert.match(lifecycle, /residentKey: "required"/u);
  assert.match(app, /const accountHandle = createAccountHandle\(\)/u);
});

test("discovery rejects an unrecognised user handle and validates its ceremony", () => {
  assert.match(webauthn, /decodeAccountUserHandle/u);
  assert.match(webauthn, /client\.challenge !== base64Url\(challenge\)/u);
  assert.match(webauthn, /client\.origin !== window\.location\.origin/u);
  assert.match(webauthn, /Passkey RP ID does not match/u);
  assert.match(webauthn, /Passkey user verification is required/u);
});

test("wallet discovery resolves the handle then checks the account's live validators", () => {
  const flow = app.slice(app.indexOf("const findByPasskey = async"), app.indexOf("const saveFoundWallet = async"));
  assert.match(flow, /discoverPasskeyAccount/u);
  assert.match(flow, /discovered\.status === "stale"/u);
  assert.match(discovery, /"accountForHandle"/u);
  assert.match(discovery, /readValidators\(account/u);
  assert.match(discovery, /verifyP256Assertion/u);
  assert.doesNotMatch(flow, /getLogs|validatorsToSearch|findWalletsByPasskey/u);
});

test("a saved passkey is not opened for signing before live control is checked", () => {
  const flow = app.slice(app.indexOf("const unlockAccount = async"), app.indexOf("const removeAccount = async"));
  assert.ok(flow.indexOf("await readAccountControl") < flow.indexOf("setSelected(refreshed)"));
  assert.match(flow, /control\.kind === "superseded"/u);
});
