import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGE_CLASSES,
  declaredClasses,
  observedClass,
  parseNameStatus,
  protocolSnapshotHasBreakingChanges,
  storageSnapshotHasBreakingChanges,
  validate,
  visibleMarkdown
} from "./validate-change-class.mjs";

const added = path => ({ path, status: "added" });
const modified = path => ({ path, status: "modified" });
const removed = path => ({ path, status: "removed" });

test("git status codes are read, with renames counted as modifications", () => {
  assert.deepEqual(parseNameStatus("A\0storage-layout.json\0M\0src/A.sol\0D\0src/B.sol\0R100\0old.sol\0src/new.sol\0"), [
    added("storage-layout.json"),
    modified("src/A.sol"),
    removed("src/B.sol"),
    { ...modified("src/new.sol"), previousPath: "old.sol" }
  ]);
  assert.throws(() => parseNameStatus("M\0"), /incomplete git M record/);
  assert.throws(() => parseNameStatus("Q\0src/A.sol\0"), /unsupported git name-status code/);
});

test("the diff decides the floor", () => {
  assert.equal(observedClass([modified("README.md")]), "implementation-only");
  assert.equal(observedClass([modified("src/LoomAccount.sol")]), "behavior-changing");
  assert.equal(observedClass([modified("protocol-surface.json")]), "wire-breaking");
  assert.equal(observedClass([modified("storage-layout.json"), modified("protocol-surface.json")]), "state-incompatible");
});

test("adding a snapshot is not moving one", () => {
  // The change that introduces a gate must not read as the worst change that
  // gate can describe, or it passes only by overstating itself.
  assert.equal(observedClass([added("storage-layout.json"), added("tools/quality/x.mjs")]), "implementation-only");
  assert.equal(observedClass([added("protocol-surface.json")]), "implementation-only");

  // Deleting one is not additive either: it removes the evidence.
  assert.equal(observedClass([removed("storage-layout.json")]), "state-incompatible");
  assert.equal(
    observedClass([{ ...modified("renamed-layout.json"), previousPath: "storage-layout.json" }]),
    "state-incompatible"
  );
});

test("snapshot contents distinguish compatible additions from breaking movement", () => {
  const storageBefore = { version: 1, contracts: { Account: [{ label: "owner", slot: 0 }] } };
  const storageAfterAppend = {
    version: 1,
    contracts: { Account: [{ label: "owner", slot: 0 }, { label: "nonce", slot: 1 }] }
  };
  const storageAfterMove = { version: 1, contracts: { Account: [{ label: "owner", slot: 1 }] } };
  assert.equal(storageSnapshotHasBreakingChanges(storageBefore, storageAfterAppend), false);
  assert.equal(storageSnapshotHasBreakingChanges(storageBefore, storageAfterMove), true);

  const protocolBefore = {
    version: 2,
    contracts: { Account: { functions: { "owner()": "0x8da5cb5b" } } },
    typedData: { "src/A.sol": { ACTION_TYPEHASH: { schema: "Action(uint256 nonce)", hash: "0x01" } } }
  };
  const protocolAfterAddition = structuredClone(protocolBefore);
  protocolAfterAddition.contracts.Account.functions["nonce()"] = "0xaffed0e0";
  const protocolAfterChange = structuredClone(protocolBefore);
  protocolAfterChange.contracts.Account.functions["owner()"] = "0x00000000";
  assert.equal(protocolSnapshotHasBreakingChanges(protocolBefore, protocolAfterAddition), false);
  assert.equal(protocolSnapshotHasBreakingChanges(protocolBefore, protocolAfterChange), true);

  assert.equal(observedClass([modified("protocol-surface.json")], { "protocol-surface.json": false }), "implementation-only");
  assert.equal(observedClass([modified("protocol-surface.json")], { "protocol-surface.json": true }), "wire-breaking");
  assert.equal(observedClass([modified("protocol-surface.json")]), "wire-breaking");
});

test("a new contract is additive; wiring it into an existing one is not", () => {
  assert.equal(observedClass([added("src/NewModule.sol")]), "additive");
  assert.equal(observedClass([added("src/NewModule.sol"), modified("src/LoomAccount.sol")]), "behavior-changing");
  assert.equal(observedClass([removed("src/Old.sol")]), "behavior-changing");
});

test("a declaration is read in any order, case, or phrasing", () => {
  assert.deepEqual(declaredClasses("Change class: wire-breaking"), ["wire-breaking"]);
  assert.deepEqual(declaredClasses("change  class : Wire-Breaking"), ["wire-breaking"]);
  assert.deepEqual(declaredClasses("## Change class: additive, behavior-changing"), ["additive", "behavior-changing"]);
  assert.deepEqual(declaredClasses("no declaration here"), []);
  assert.deepEqual(declaredClasses("<!-- Change class: state-incompatible -->"), []);
  assert.deepEqual(declaredClasses("<!-- <!--> Change class: state-incompatible -->"), []);
  assert.deepEqual(declaredClasses("<!-- unclosed\nChange class: state-incompatible"), []);
  assert.deepEqual(declaredClasses("not a declaration: Change class: state-incompatible"), []);
  assert.match(visibleMarkdown("Change <!-- hidden -->class: additive"), /^Change {16}class: additive$/);
});

test("a declaration must make one visible choice", () => {
  assert.match(
    validate([modified("src/LoomAccount.sol")], "Change class: implementation-only, behavior-changing")[0],
    /exactly one change class/
  );
  assert.ok(validate([modified("src/LoomAccount.sol")], "<!-- Change class: state-incompatible -->")[0]);
});

test("a documentation change needs no declaration", () => {
  assert.deepEqual(validate([modified("docs/README.md")], ""), []);
});

test("a protocol change without a declaration is refused", () => {
  const problems = validate([modified("src/LoomAccount.sol")], "");
  assert.ok(problems[0].includes("must declare its impact"));
  assert.ok(problems.some(line => line.includes("Change class: behavior-changing")));
});

test("understating the diff is refused, and the reason names the artifact", () => {
  const storage = validate([modified("storage-layout.json")], "Change class: wire-breaking");
  assert.ok(storage[0].includes('Declared "wire-breaking", but the diff shows "state-incompatible"'));
  assert.ok(storage.some(line => line.includes("storage-layout.json moved")));

  const surface = validate([modified("protocol-surface.json")], "Change class: behavior-changing");
  assert.ok(surface.some(line => line.includes("protocol-surface.json moved")));
});

test("declaring more than the diff shows is allowed", () => {
  assert.deepEqual(validate([modified("src/LoomAccount.sol")], "Change class: state-incompatible"), []);
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
