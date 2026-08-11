import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalType,
  compareSnapshots,
  selectorCollisions,
  signatureOf,
  surfaceOf,
  typeHashesIn
} from "./validate-protocol-surface.mjs";

test("tuples are expanded the way selector hashing requires", () => {
  assert.equal(canonicalType({ type: "uint256" }), "uint256");
  assert.equal(
    canonicalType({ type: "tuple", components: [{ type: "address" }, { type: "uint256" }] }),
    "(address,uint256)"
  );
  assert.equal(
    canonicalType({ type: "tuple[]", components: [{ type: "address" }, { type: "bytes" }] }),
    "(address,bytes)[]"
  );
  assert.equal(
    signatureOf({ name: "execute", inputs: [{ type: "bytes32" }, { type: "bytes" }] }),
    "execute(bytes32,bytes)"
  );
});

test("selectors, topics, and error selectors match the known values", () => {
  const surface = surfaceOf([
    {
      type: "function",
      name: "transfer",
      inputs: [{ type: "address" }, { type: "uint256" }],
      outputs: [{ type: "bool" }],
      stateMutability: "nonpayable"
    },
    {
      type: "event",
      name: "Transfer",
      anonymous: false,
      inputs: [
        { type: "address", indexed: true },
        { type: "address", indexed: true },
        { type: "uint256", indexed: false }
      ]
    },
    { type: "error", name: "Error", inputs: [{ type: "string" }] }
  ]);

  assert.equal(surface.functions["transfer(address,uint256)"], "0xa9059cbb");
  assert.equal(
    surface.events["Transfer(address,address,uint256)"],
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  );
  assert.equal(surface.errors["Error(string)"], "0x08c379a0");
  assert.deepEqual(surface.functionOutputs["transfer(address,uint256)"], ["bool"]);
  assert.equal(surface.functionMutability["transfer(address,uint256)"], "nonpayable");
  assert.deepEqual(surface.eventLayouts["Transfer(address,address,uint256)"], {
    anonymous: false,
    indexed: [true, true, false]
  });
});

test("a selector collision is reported rather than recorded", () => {
  // Two real signatures whose first four keccak bytes agree.
  const collisions = selectorCollisions({
    functions: { "a(uint256)": "0x11111111", "b(uint256)": "0x11111111" },
    errors: {}
  });
  assert.equal(collisions.length, 1);
  assert.match(collisions[0], /share selector 0x11111111/u);
});

test("additions must be recorded; removals and changes remain breaking", () => {
  const empty = { version: 2, contracts: {}, typedData: {} };
  const before = {
    version: 2,
    contracts: { "A:A": { functions: { "a()": "0xaaaaaaaa" }, events: {}, errors: {} } },
    typedData: {}
  };

  const added = {
    version: 2,
    contracts: { "A:A": { functions: { "a()": "0xaaaaaaaa", "b()": "0xbbbbbbbb" }, events: {}, errors: {} } },
    typedData: {}
  };
  assert.ok(compareSnapshots(before, added)[0].includes("was added but is not recorded"));

  const removed = { version: 2, contracts: { "A:A": { functions: {}, events: {}, errors: {} } }, typedData: {} };
  assert.ok(compareSnapshots(before, removed)[0].includes("was removed"));

  const changed = {
    version: 2,
    contracts: { "A:A": { functions: { "a()": "0xcccccccc" }, events: {}, errors: {} } },
    typedData: {}
  };
  assert.ok(compareSnapshots(before, changed)[0].includes("changed"));

  assert.ok(compareSnapshots(before, empty)[0].includes("disappeared"));
});

test("function decoding and event layout changes are part of the wire surface", () => {
  const beforeSurface = surfaceOf([
    {
      type: "function",
      name: "read",
      inputs: [],
      outputs: [{ type: "address" }],
      stateMutability: "view"
    },
    {
      type: "event",
      name: "Changed",
      anonymous: false,
      inputs: [{ type: "address", indexed: true }]
    }
  ]);
  const afterSurface = surfaceOf([
    {
      type: "function",
      name: "read",
      inputs: [],
      outputs: [{ type: "bytes32" }],
      stateMutability: "nonpayable"
    },
    {
      type: "event",
      name: "Changed",
      anonymous: true,
      inputs: [{ type: "address", indexed: false }]
    }
  ]);
  const before = { version: 2, contracts: { "A:A": beforeSurface }, typedData: {} };
  const after = { version: 2, contracts: { "A:A": afterSurface }, typedData: {} };
  const problems = compareSnapshots(before, after);

  assert.ok(problems.some(problem => problem.includes("functionOutputs read() changed")));
  assert.ok(problems.some(problem => problem.includes("functionMutability read() changed")));
  assert.ok(problems.some(problem => problem.includes("eventLayouts Changed(address) changed")));
});

test("a typed-data schema change is reported as prose, not as two hashes", () => {
  const before = {
    version: 2,
    contracts: {},
    typedData: { "src/A.sol": { A_TYPEHASH: { schema: "A(uint256 a,uint64 b)", hash: "0x00" } } }
  };
  const after = {
    version: 2,
    contracts: {},
    typedData: { "src/A.sol": { A_TYPEHASH: { schema: "A(uint64 b,uint256 a)", hash: "0x01" } } }
  };

  const [problem] = compareSnapshots(before, after);
  assert.match(problem, /A_TYPEHASH schema changed/u);
  assert.match(problem, /was: A\(uint256 a,uint64 b\)/u);
  assert.match(problem, /now: A\(uint64 b,uint256 a\)/u);

  const staleHash = {
    version: 2,
    contracts: {},
    typedData: { "src/A.sol": { A_TYPEHASH: { schema: "A(uint256 a,uint64 b)", hash: "0x02" } } }
  };
  assert.match(compareSnapshots(before, staleHash)[0], /A_TYPEHASH hash changed/u);
});

test("type hashes are read out of source, including multi-line declarations", () => {
  const found = typeHashesIn(`
    bytes32 public constant FREEZE_TYPEHASH =
        keccak256("Freeze(bytes32 guardianLeaf,uint256 nonce)");
    bytes32 private constant NAME_HASH = keccak256("LoomAccount");
  `);
  assert.deepEqual(Object.keys(found), ["FREEZE_TYPEHASH"], "only *TYPEHASH constants are schemas");
  assert.equal(found.FREEZE_TYPEHASH.schema, "Freeze(bytes32 guardianLeaf,uint256 nonce)");
});
