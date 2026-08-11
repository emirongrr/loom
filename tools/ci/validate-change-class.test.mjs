import assert from "node:assert/strict";
import test from "node:test";

import { CHANGE_CLASSES, declaredClasses, observedClass, validate } from "./validate-change-class.mjs";

test("the diff decides the floor", () => {
  assert.equal(observedClass(["README.md", "docs/design/execution.md"]), "implementation-only");
  assert.equal(observedClass(["src/LoomAccount.sol"]), "behavior-changing");
  assert.equal(observedClass(["protocol-surface.json"]), "wire-breaking");
  assert.equal(observedClass(["storage-layout.json", "protocol-surface.json"]), "state-incompatible");
});

test("a declaration is read in any order, case, or phrasing", () => {
  assert.deepEqual(declaredClasses("Change class: wire-breaking"), ["wire-breaking"]);
  assert.deepEqual(declaredClasses("change  class : Wire-Breaking"), ["wire-breaking"]);
  assert.deepEqual(declaredClasses("## Change class: additive, behavior-changing"), ["additive", "behavior-changing"]);
  assert.deepEqual(declaredClasses("no declaration here"), []);
});

test("a documentation change needs no declaration", () => {
  assert.deepEqual(validate(["docs/README.md"], ""), []);
});

test("a protocol change without a declaration is refused", () => {
  const problems = validate(["src/LoomAccount.sol"], "");
  assert.ok(problems[0].includes("must declare its impact"));
  assert.ok(problems.some(line => line.includes("Change class: behavior-changing")));
});

test("understating the diff is refused, and the reason names the artifact", () => {
  const storage = validate(["storage-layout.json"], "Change class: wire-breaking");
  assert.ok(storage[0].includes('Declared "wire-breaking", but the diff shows "state-incompatible"'));
  assert.ok(storage.some(line => line.includes("storage-layout.json changed")));

  const surface = validate(["protocol-surface.json"], "Change class: behavior-changing");
  assert.ok(surface.some(line => line.includes("protocol-surface.json changed")));
});

test("declaring more than the diff shows is allowed", () => {
  assert.deepEqual(validate(["src/LoomAccount.sol"], "Change class: state-incompatible"), []);
});

test("every class the gate accepts is one a reviewer can act on", () => {
  assert.deepEqual(CHANGE_CLASSES, [
    "implementation-only",
    "additive",
    "behavior-changing",
    "wire-breaking",
    "state-incompatible"
  ]);
});
