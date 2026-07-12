// Generates the differential fixture that pins @loom/core's ERC-4337 v0.9
// user-operation hashing against the on-chain EntryPoint.
//
// @loom/core computes the EIP-712 struct hash and user-operation hash off-chain;
// this fixture is the shared oracle for two checks:
//   - test/integration/UserOpHashDifferential.t.sol rebuilds each packed
//     operation and recomputes the struct hash with the real
//     account-abstraction UserOperationLib, plus the EIP-712 domain wrapper, and
//     asserts equality with the hashes below — so the fixture stays honest to
//     the contracts.
//   - tools/sdk/generate-userop-hash-fixture.test.mjs re-runs this generator and
//     asserts the committed fixture is current — so it stays honest to @loom/core.
//
// Run `npm run sdk:userop-hash:generate` after an intentional hashing change and
// commit the regenerated fixture.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getUserOpHash, hashPackedUserOperation, packUserOperation } from "../../packages/core/dist/index.js";

// Canonical EntryPoint v0.9 address and mainnet chain id. Values are fixed so the
// fixture is deterministic; the differential test uses the same domain inputs.
const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const chainId = 1n;

const inputs = {
  minimal: {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 5n,
    callData: "0xabcdef",
    callGasLimit: 100000n,
    verificationGasLimit: 200000n,
    preVerificationGas: 21000n,
    maxFeePerGas: 2000000000n,
    maxPriorityFeePerGas: 1000000000n,
    signature: "0xdead"
  },
  full: {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 7n,
    factory: "0x2222222222222222222222222222222222222222",
    factoryData: "0xcafe",
    callData: "0x",
    callGasLimit: 123456n,
    verificationGasLimit: 654321n,
    preVerificationGas: 50000n,
    maxFeePerGas: 3000000000n,
    maxPriorityFeePerGas: 1500000000n,
    paymaster: "0x3333333333333333333333333333333333333333",
    paymasterVerificationGasLimit: 50000n,
    paymasterPostOpGasLimit: 40000n,
    paymasterData: "0xbeef",
    signature: "0xdead"
  }
};

function buildCase(input) {
  const packed = packUserOperation(input);
  return {
    op: {
      sender: packed.sender,
      nonce: packed.nonce.toString(),
      initCode: packed.initCode,
      callData: packed.callData,
      accountGasLimits: packed.accountGasLimits,
      preVerificationGas: packed.preVerificationGas.toString(),
      gasFees: packed.gasFees,
      paymasterAndData: packed.paymasterAndData,
      signature: packed.signature
    },
    entryPoint,
    chainId: chainId.toString(),
    structHash: hashPackedUserOperation(packed),
    userOpHash: getUserOpHash(packed, entryPoint, chainId)
  };
}

export function buildFixture() {
  const out = { cases: {} };
  for (const [name, input] of Object.entries(inputs)) {
    out.cases[name] = buildCase(input);
  }
  return out;
}

const fixturePath = fileURLToPath(new URL("../../test/fixtures/userop-hash.json", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(fixturePath, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  console.log(`wrote ${fixturePath}`);
}
