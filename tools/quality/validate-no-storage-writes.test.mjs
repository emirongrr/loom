import assert from "node:assert/strict";
import test from "node:test";

import {
  auditContract,
  findStorageWrites,
  stripMetadata,
  STORAGE_FREE_CONTRACTS
} from "./validate-no-storage-writes.mjs";

const bytes = (...values) => Uint8Array.from(values);

test("an SSTORE is found, wherever it sits", () => {
  assert.deepEqual(findStorageWrites(bytes(0x60, 0x01, 0x60, 0x00, 0x55)), [
    { offset: 4, opcode: "SSTORE" }
  ]);
});

test("a TSTORE is found too, because transient state is still state", () => {
  assert.deepEqual(findStorageWrites(bytes(0x5d)), [{ offset: 0, opcode: "TSTORE" }]);
});

// The reason this walks instructions instead of searching for a byte. A naive
// scan reports every one of these, and a gate that cries wolf gets switched off.
test("0x55 inside a PUSH immediate is data, not an instruction", () => {
  assert.deepEqual(findStorageWrites(bytes(0x60, 0x55)), [], "PUSH1 0x55");
  assert.deepEqual(findStorageWrites(bytes(0x61, 0x55, 0x55)), [], "PUSH2 0x5555");
  const push32 = bytes(0x7f, ...new Array(32).fill(0x55));
  assert.deepEqual(findStorageWrites(push32), [], "PUSH32 of nothing but 0x55");
});

test("PUSH0 carries no immediate, so the next byte is still an instruction", () => {
  assert.deepEqual(findStorageWrites(bytes(0x5f, 0x55)), [{ offset: 1, opcode: "SSTORE" }]);
});

test("an instruction after a PUSH immediate is not skipped", () => {
  assert.deepEqual(findStorageWrites(bytes(0x60, 0x55, 0x55)), [{ offset: 2, opcode: "SSTORE" }]);
});

test("the CBOR metadata trailer is removed, since a source hash is not code", () => {
  const body = bytes(0x00, 0x01);
  const trailer = bytes(0x55, 0x55, 0x00, 0x02);
  const withTrailer = Uint8Array.from([...body, ...trailer]);
  assert.deepEqual([...stripMetadata(withTrailer)], [...body]);
  assert.deepEqual(findStorageWrites(stripMetadata(withTrailer)), []);
});

test("a nonsense trailer length leaves the input alone rather than truncating it", () => {
  const absurd = bytes(0x55, 0xff, 0xff);
  assert.deepEqual([...stripMetadata(absurd)], [...absurd]);
});

// The tests above exercise the walker. These two exercise the whole pipeline --
// forge inspect, the output shape, the metadata strip and the walk -- against
// real compiler output, so a break anywhere in it is caught.
//
// This is the negative case the layout gate cannot provide: `storage:check`
// allows appending, so a contract that gains its first slot passes it. Here a
// contract that writes storage must be reported, or the gate proves nothing.
test("a contract that does write storage is reported", { timeout: 600_000 }, () => {
  const writes = auditContract("src/recovery/RecoveryManager.sol:RecoveryManager");
  assert.ok(
    writes.length > 0,
    "RecoveryManager holds recovery state; if no write is found the audit is not working"
  );
});

test("the pinned storage-free contracts write nothing", { timeout: 600_000 }, () => {
  assert.ok(STORAGE_FREE_CONTRACTS.length > 0, "an empty pin list would pass vacuously");
  for (const target of STORAGE_FREE_CONTRACTS) {
    assert.deepEqual(auditContract(target), [], `${target} must contain no storage write`);
  }
});
