import assert from "node:assert/strict";
import test from "node:test";

import { compareSnapshots, normalizeLayout, stableType } from "./validate-storage-layout.mjs";

const layout = entries => ({ version: 1, contracts: { "src/A.sol:A": entries } });
const slot = (label, index, type = "t_uint256", offset = 0) => ({ label, slot: index, offset, type });

test("an unchanged layout reports nothing", () => {
  const before = layout([slot("a", 0), slot("b", 1)]);
  assert.deepEqual(compareSnapshots(before, layout([slot("a", 0), slot("b", 1)])), []);
});

test("appending is allowed, because the block is append-only", () => {
  const before = layout([slot("a", 0)]);
  assert.deepEqual(compareSnapshots(before, layout([slot("a", 0), slot("appended", 1)])), []);
});

test("reordering, removing, retyping, and repacking are all reported", () => {
  const before = layout([slot("a", 0, "t_address"), slot("b", 1, "t_uint64")]);

  const reordered = compareSnapshots(before, layout([slot("b", 0, "t_uint64"), slot("a", 1, "t_address")]));
  assert.ok(reordered.some(problem => problem.includes("label changed")), "a reorder must be reported");

  const removed = compareSnapshots(before, layout([slot("a", 0, "t_address")]));
  assert.ok(removed.some(problem => problem.includes("was removed")), "a removal must be reported");

  const retyped = compareSnapshots(before, layout([slot("a", 0, "t_address"), slot("b", 1, "t_uint128")]));
  assert.ok(retyped.some(problem => problem.includes("type changed")), "a resize must be reported");

  // Repacking moves a later variable's offset without changing its slot, which
  // is the case a reader is least likely to spot by eye.
  const repacked = compareSnapshots(before, layout([slot("a", 0, "t_address"), slot("b", 0, "t_uint64", 20)]));
  assert.ok(repacked.some(problem => problem.includes("offset changed")), "repacking must be reported");
});

test("a pinned contract that disappears is reported", () => {
  assert.ok(compareSnapshots(layout([slot("a", 0)]), { version: 1, contracts: {} })[0].includes("missing"));
});

test("struct AST ids are normalised away but struct names are kept", () => {
  assert.equal(stableType("t_struct(ScheduledOperation)130_storage"), "t_struct(ScheduledOperation)_storage");
  assert.equal(
    stableType("t_mapping(t_bytes32,t_struct(Pending)147_storage)"),
    "t_mapping(t_bytes32,t_struct(Pending)_storage)"
  );
  assert.equal(stableType("t_address"), "t_address");
  assert.notEqual(stableType("t_struct(A)1_storage"), stableType("t_struct(B)1_storage"));
});

test("normalizeLayout keeps only the fields that describe storage", () => {
  const normalized = normalizeLayout({
    storage: [{ astId: 281, contract: "src/A.sol:A", label: "a", offset: 0, slot: "0", type: "t_address" }]
  });
  assert.deepEqual(normalized, [{ label: "a", slot: 0, offset: 0, type: "t_address" }]);
});
