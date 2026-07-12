import assert from "node:assert/strict";
import test from "node:test";
import {
  getUserOpHash,
  hashPackedUserOperation,
  packUserOperation,
  sizeOfHex,
  unpackUserOperation
} from "../dist/index.js";

// EntryPoint v0.9 mainnet domain, and the values pinned by the Solidity
// differential in test/fixtures/userop-hash.json (verified against the real
// account-abstraction UserOperationLib).
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const sender = "0x1111111111111111111111111111111111111111";
const factory = "0x2222222222222222222222222222222222222222";
const paymaster = "0x3333333333333333333333333333333333333333";

const base = {
  sender,
  nonce: 5n,
  callData: "0xabcdef",
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 21_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  signature: "0xdead"
};

test("packing composes accountGasLimits and gasFees in the EntryPoint order", () => {
  const packed = packUserOperation(base);
  // verificationGasLimit (high 16 bytes) then callGasLimit (low 16 bytes)
  assert.equal(packed.accountGasLimits, `0x${(200_000).toString(16).padStart(32, "0")}${(100_000).toString(16).padStart(32, "0")}`);
  // maxPriorityFeePerGas (high) then maxFeePerGas (low)
  assert.equal(packed.gasFees, `0x${(1_000_000_000).toString(16).padStart(32, "0")}${(2_000_000_000).toString(16).padStart(32, "0")}`);
  assert.equal(packed.initCode, "0x");
  assert.equal(packed.paymasterAndData, "0x");
});

test("factory and paymaster fields pack into initCode and paymasterAndData", () => {
  const packed = packUserOperation({
    ...base,
    factory,
    factoryData: "0xcafe",
    paymaster,
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 40_000n,
    paymasterData: "0xbeef"
  });
  assert.equal(packed.initCode, `${factory}cafe`);
  assert.equal(sizeOfHex(packed.paymasterAndData), 20 + 16 + 16 + 2);
  assert.ok(packed.paymasterAndData.startsWith(paymaster));
});

test("pack and unpack round-trip a full operation", () => {
  const op = {
    ...base,
    factory,
    factoryData: "0xcafe",
    paymaster,
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 40_000n,
    paymasterData: "0xbeef"
  };
  assert.deepEqual(unpackUserOperation(packUserOperation(op)), op);
});

test("a minimal operation round-trips without factory or paymaster fields", () => {
  const unpacked = unpackUserOperation(packUserOperation(base));
  assert.deepEqual(unpacked, base);
  assert.equal("factory" in unpacked, false);
  assert.equal("paymaster" in unpacked, false);
});

test("hashes match the differentially-verified fixture values", () => {
  const packed = packUserOperation(base);
  assert.equal(hashPackedUserOperation(packed), "0x802927a7c1ea5f1bd2a8c03d503634c1d88fe0453950135de2530c7db3de96fb");
  assert.equal(getUserOpHash(packed, ENTRY_POINT, 1n), "0x0b383039d106c43531bbc5fc59ac49c49613e97785d36b7390e98438e780af2c");
});

test("the user-operation hash is bound to the EntryPoint and chain", () => {
  const packed = packUserOperation(base);
  const a = getUserOpHash(packed, ENTRY_POINT, 1n);
  assert.notEqual(a, getUserOpHash(packed, ENTRY_POINT, 10n));
  assert.notEqual(a, getUserOpHash(packed, "0x1111111111111111111111111111111111111111", 1n));
});

test("a changed field changes the struct hash", () => {
  const packed = packUserOperation(base);
  const mutated = packUserOperation({ ...base, nonce: base.nonce + 1n });
  assert.notEqual(hashPackedUserOperation(packed), hashPackedUserOperation(mutated));
});
