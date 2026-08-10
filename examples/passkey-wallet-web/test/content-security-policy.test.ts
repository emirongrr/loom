import { strict as assert } from "node:assert";
import test from "node:test";
import { contentSecurityPolicy } from "../vite.config.ts";

// The policy used to exist only as a `vite dev` response header, so the build
// anyone deploys carried none. These assertions are about that: the shipped
// policy must stay strict, and the two forms it takes must differ only where a
// browser forces them to.

test("the production policy does not inherit development affordances", () => {
  const production = contentSecurityPolicy({ development: false, asMetaTag: true });

  assert.ok(!production.includes("unsafe-inline"), "production style-src must not allow inline styles");
  assert.ok(!production.includes("unsafe-eval"), "production must not allow eval");
  assert.ok(production.includes("script-src 'self'"), "script must stay same-origin only");
  assert.ok(production.includes("style-src 'self';"), "style must stay same-origin only");
  assert.ok(production.includes("default-src 'self'"));
  assert.ok(production.includes("object-src 'none'"));
  assert.ok(production.includes("base-uri 'none'"));
});

test("development relaxes inline styles and nothing else", () => {
  const development = contentSecurityPolicy({ development: true, asMetaTag: false });
  const production = contentSecurityPolicy({ development: false, asMetaTag: false });

  assert.equal(development.replace(" 'unsafe-inline'", ""), production);
  assert.ok(!development.includes("unsafe-eval"), "development must not allow eval either");
});

test("frame-ancestors is emitted only where a browser honours it", () => {
  // Ignored in a meta tag, so claiming it there would advertise protection the
  // page does not have. The README asks the host to send it as a header.
  assert.ok(!contentSecurityPolicy({ development: false, asMetaTag: true }).includes("frame-ancestors"));
  assert.ok(contentSecurityPolicy({ development: false, asMetaTag: false }).includes("frame-ancestors 'none'"));
});
