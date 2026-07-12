// Generates the differential fixture that pins @loom/core's account derivation
// against the on-chain factory encoding.
//
// @loom/core encodes LoomAccount.initialize and LoomAccountFactory.createAccount
// calldata and derives the CREATE2 proxy address off-chain; this fixture is the
// shared oracle for two checks:
//   - test/integration/AccountDerivationDifferential.t.sol recomputes the same
//     calldata with Solidity abi.encodeCall and the same address with the
//     CREATE2 keccak formula, and additionally proves the composed formula
//     matches the real LoomAccountFactory.getAddress — so the fixture stays
//     honest to the contracts.
//   - tools/sdk/generate-account-derivation-fixture.test.mjs re-runs this
//     generator and asserts the committed fixture is current — so it stays
//     honest to @loom/core.
//
// Run `npm run sdk:derivation:generate` after an intentional encoding change and
// commit the regenerated fixture.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeCreate2Address,
  deriveAccountAddress,
  encodeCreateAccountCall,
  encodeInitializeCall
} from "../../packages/core/dist/index.js";

// Fixed, deterministic inputs chosen to exercise the encoding: distinct
// addresses, a non-zero threshold, and modules with empty and non-empty
// initData. The proxy creation code is a short dummy — the formula, not the
// real bytecode, is what the cross-language check pins.
const inputs = {
  entryPoint: "0x00000000000000000000000000000000000000e9",
  factory: "0x1111111111111111111111111111111111111111",
  implementation: "0x2222222222222222222222222222222222222222",
  proxyCreationCode: "0x600a80600b3d393df3fe",
  salt: `0x${"a1".repeat(32)}`,
  guardianRoot: `0x${"b2".repeat(32)}`,
  guardianThreshold: 2,
  configHash: `0x${"c3".repeat(32)}`,
  modules: [
    { moduleTypeId: "1", module: "0x3333333333333333333333333333333333333333", initData: "0xdeadbeef" },
    { moduleTypeId: "4", module: "0x4444444444444444444444444444444444444444", initData: "0x" }
  ]
};

export function buildFixture() {
  const config = {
    entryPoint: inputs.entryPoint,
    guardianRoot: inputs.guardianRoot,
    guardianThreshold: inputs.guardianThreshold,
    configHash: inputs.configHash,
    modules: inputs.modules.map(m => ({ moduleTypeId: BigInt(m.moduleTypeId), module: m.module, initData: m.initData }))
  };
  return {
    inputs,
    outputs: {
      initializeCalldata: encodeInitializeCall(config),
      createAccountCalldata: encodeCreateAccountCall(inputs.salt, config),
      create2Example: computeCreate2Address(
        inputs.factory,
        inputs.salt,
        "0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a"
      ),
      derivedAddress: deriveAccountAddress({
        factory: inputs.factory,
        implementation: inputs.implementation,
        proxyCreationCode: inputs.proxyCreationCode,
        salt: inputs.salt,
        config
      })
    }
  };
}

const fixturePath = fileURLToPath(new URL("../../test/fixtures/account-derivation.json", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(fixturePath, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  console.log(`wrote ${fixturePath}`);
}
