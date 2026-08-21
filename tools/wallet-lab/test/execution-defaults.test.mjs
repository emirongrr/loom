import assert from "node:assert/strict";
import test from "node:test";

import { defaultExecutionArgument } from "../ui/execution-defaults.mjs";

const CALLER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

test("execution defaults cover common scalar ABI inputs", () => {
  assert.equal(defaultExecutionArgument({ name: "recipient", type: "address" }, { caller: CALLER }), CALLER);
  assert.equal(defaultExecutionArgument({ name: "amount", type: "uint256" }, { caller: CALLER }), "1");
  assert.equal(defaultExecutionArgument({ name: "nonce", type: "uint256" }, { caller: CALLER }), "0");
  assert.equal(defaultExecutionArgument({ name: "enabled", type: "bool" }, { caller: CALLER }), "true");
  assert.equal(defaultExecutionArgument({ name: "label", type: "string" }, { caller: CALLER }), "Loom example");
  assert.equal(defaultExecutionArgument({ name: "payload", type: "bytes" }, { caller: CALLER }), "0x00");
  assert.equal(defaultExecutionArgument({ name: "salt", type: "bytes32" }, { caller: CALLER }), `0x${"0".repeat(63)}1`);
  assert.equal(defaultExecutionArgument({ name: "callback", type: "function" }, { caller: CALLER }), `0x${"0".repeat(48)}`);
});

test("execution defaults produce valid JSON for arrays and canonical tuples", () => {
  assert.deepEqual(JSON.parse(defaultExecutionArgument({ name: "guardians", type: "address[]" }, { caller: CALLER })), [CALLER]);
  assert.deepEqual(JSON.parse(defaultExecutionArgument({ name: "weights", type: "uint256[2]" }, { caller: CALLER })), ["1", "1"]);
  assert.deepEqual(JSON.parse(defaultExecutionArgument({ name: "item", type: "(address,uint256,bool)" }, { caller: CALLER })), [CALLER, "1", true]);
  assert.deepEqual(JSON.parse(defaultExecutionArgument({ name: "items", type: "(address,uint256)[]" }, { caller: CALLER })), [[CALLER, "1"]]);
});

test("execution defaults are deterministic and reject unsupported ABI types", () => {
  const parameter = { name: "salt", type: "bytes32" };
  assert.equal(defaultExecutionArgument(parameter, { caller: CALLER }), defaultExecutionArgument(parameter, { caller: CALLER }));
  assert.throws(() => defaultExecutionArgument({ name: "value", type: "fixed128x18" }, { caller: CALLER }), /No example value/u);
});
