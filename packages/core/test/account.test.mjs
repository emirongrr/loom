import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCreate2Address,
  deriveAccountAddress,
  encodeCreateAccountCall,
  encodeInitializeCall,
  LoomError
} from "../dist/index.js";

const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const factory = "0x1111111111111111111111111111111111111111";
const implementation = "0x2222222222222222222222222222222222222222";
const validator = "0x3333333333333333333333333333333333333333";
const salt = `0x${"a1".repeat(32)}`;

const config = {
  entryPoint,
  guardianRoot: `0x${"b2".repeat(32)}`,
  guardianThreshold: 2,
  configHash: `0x${"c3".repeat(32)}`,
  modules: [
    { moduleTypeId: 1n, module: validator, initData: "0xdeadbeef" },
    { moduleTypeId: 4n, module: factory, initData: "0x" }
  ]
};

test("computeCreate2Address matches the EIP-1014 reference vector", () => {
  // Example 0 from EIP-1014: deployer 0x0, salt 0x0, code 0x00.
  const codeHash = "0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a";
  assert.equal(
    computeCreate2Address("0x0000000000000000000000000000000000000000", `0x${"00".repeat(32)}`, codeHash),
    "0x4D1A2e2bB4F88F0250f26Ffff098B0b30B26BF38"
  );
});

test("initialize and createAccount calldata start with distinct selectors and embed the modules", () => {
  const init = encodeInitializeCall(config);
  const create = encodeCreateAccountCall(salt, config);
  assert.notEqual(init.slice(0, 10), create.slice(0, 10));
  assert.ok(init.includes("deadbeef"));
  assert.ok(create.includes(salt.slice(2)));
});

test("deriveAccountAddress composes initialize calldata, constructor args, and CREATE2", () => {
  const address = deriveAccountAddress({
    factory,
    implementation,
    proxyCreationCode: "0x600a80600b3d393df3fe",
    salt,
    config
  });
  assert.match(address, /^0x[0-9a-fA-F]{40}$/);
  // Deterministic: same inputs, same address; different salt, different address.
  assert.equal(
    address,
    deriveAccountAddress({ factory, implementation, proxyCreationCode: "0x600a80600b3d393df3fe", salt, config })
  );
  assert.notEqual(
    address,
    deriveAccountAddress({
      factory,
      implementation,
      proxyCreationCode: "0x600a80600b3d393df3fe",
      salt: `0x${"a2".repeat(32)}`,
      config
    })
  );
});

test("derivation fails closed when the proxy creation code does not match the manifest hash", () => {
  try {
    deriveAccountAddress({
      factory,
      implementation,
      proxyCreationCode: "0x600a80600b3d393df3fe",
      expectedProxyCreationCodeHash: `0x${"00".repeat(32)}`,
      salt,
      config
    });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof LoomError);
    assert.equal(error.code, "MANIFEST_CODE_HASH_MISMATCH");
  }
});
