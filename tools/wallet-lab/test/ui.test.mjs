import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const uiRoot = new URL("../ui/", import.meta.url);

test("Wallet Lab exposes one accessible workspace for every evidence view", () => {
  const html = readFileSync(new URL("index.html", uiRoot), "utf8");
  const script = readFileSync(new URL("app.js", uiRoot), "utf8");

  for (const panel of ["timeline", "userop", "webauthn", "network", "deployment"]) {
    assert.match(html, new RegExp(`id="tab-${panel}"[^>]+role="tab"|role="tab"[^>]+id="tab-${panel}"`, "u"));
    assert.match(html, new RegExp(`id="panel-${panel}"[^>]+role="tabpanel"|role="tabpanel"[^>]+id="panel-${panel}"`, "u"));
  }
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/u);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/u);
  assert.match(script, /function renderTimeline\(/u);
  assert.match(script, /function renderUserOperation\(/u);
  assert.match(script, /function renderWebAuthn\(/u);
  assert.match(script, /function renderNetwork\(/u);
  assert.match(script, /function renderDeployment\(/u);
  assert.match(script, /function renderFunctionInspector\(/u);
  assert.match(script, /function renderEvmTrace\(/u);
  assert.match(script, /escapeHtml\(format\(value\)\)/u);
});
