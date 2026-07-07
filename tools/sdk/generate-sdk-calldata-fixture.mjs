// Generates the differential fixture that pins the @loom/account lifecycle
// calldata encoder against on-chain Solidity abi.encodeCall.
//
// The encoder hand-rolls ABI encoding (hardcoded 4-byte selectors, manual
// offset/tuple math), which can silently drift from the contract signatures it
// targets. This fixture is the shared oracle for two checks:
//   - test/SdkCalldataDifferential.t.sol recomputes each case with Solidity
//     abi.encodeCall and asserts it equals the calldata below, so the fixture
//     stays honest to the contracts.
//   - packages/account/test/lifecycle-calldata-differential.test.mjs re-runs the
//     encoder and asserts it still equals the calldata below, so the fixture
//     stays honest to the SDK.
//
// Run `npm run sdk:calldata:generate` after an intentional encoder or signature
// change; commit the regenerated fixture.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLifecycleCallEncoder } from "../../packages/account/src/index.js";

const encoder = createLifecycleCallEncoder();

// Canonical, deterministic inputs. Values are chosen to exercise the encoding,
// not to be realistic: distinct addresses, a zero and a large uint256, and both
// empty and non-empty dynamic `bytes`.
const cases = {
  scheduleCall: {
    group: "account",
    fn: "scheduleCall",
    args: {
      target: "0x1111111111111111111111111111111111111111",
      value: "0",
      data: "0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000de0b6b3a7640000",
      delay: "259200"
    }
  },
  executeScheduled: {
    group: "account",
    fn: "executeScheduled",
    args: {
      target: "0x3333333333333333333333333333333333333333",
      value: "1000000000000000000",
      data: "0xdeadbeef"
    }
  },
  executeScheduledEmptyData: {
    group: "account",
    fn: "executeScheduled",
    args: {
      target: "0x4444444444444444444444444444444444444444",
      value: "0",
      data: "0x"
    }
  },
  cancelScheduled: {
    group: "account",
    fn: "cancelScheduled",
    args: {
      operationId: "0x5555555555555555555555555555555555555555555555555555555555555555"
    }
  },
  scheduleMigration: {
    group: "account",
    fn: "scheduleMigration",
    args: {
      destination: "0x6666666666666666666666666666666666666666",
      destinationCodeHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
      destinationConfigHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
      callsHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      delay: "259200",
      executionWindow: "604800"
    }
  },
  cancelMigration: {
    group: "account",
    fn: "cancelMigration",
    args: {}
  },
  revokeTokenAllowance: {
    group: "account",
    fn: "revokeTokenAllowance",
    args: {
      token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spender: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }
};

export function encodeCase(entry) {
  const group = encoder[entry.group];
  if (!group || typeof group[entry.fn] !== "function") {
    throw new Error(`unknown encoder ${entry.group}.${entry.fn}`);
  }
  return group[entry.fn](toEncoderInput(entry));
}

// Maps the fixture's string args to the encoder's expected input shape (bigint
// for numeric fields). Kept in one place so the generator and the freshness
// test agree.
export function toEncoderInput(entry) {
  const a = entry.args;
  switch (entry.fn) {
    case "scheduleCall":
      return { target: a.target, value: BigInt(a.value), data: a.data, delay: BigInt(a.delay) };
    case "executeScheduled":
      return { target: a.target, value: BigInt(a.value), data: a.data };
    case "cancelScheduled":
      return { operationId: a.operationId };
    case "scheduleMigration":
      return {
        destination: a.destination,
        destinationCodeHash: a.destinationCodeHash,
        destinationConfigHash: a.destinationConfigHash,
        callsHash: a.callsHash,
        delay: BigInt(a.delay),
        executionWindow: BigInt(a.executionWindow)
      };
    case "cancelMigration":
      return {};
    case "revokeTokenAllowance":
      return { token: a.token, spender: a.spender };
    default:
      throw new Error(`no input mapping for ${entry.fn}`);
  }
}

export function buildFixture() {
  const out = { cases: {} };
  for (const [name, entry] of Object.entries(cases)) {
    out.cases[name] = { group: entry.group, fn: entry.fn, args: entry.args, calldata: encodeCase(entry) };
  }
  return out;
}

const fixturePath = fileURLToPath(new URL("../../test/fixtures/sdk-calldata.json", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(fixturePath, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  console.log(`wrote ${fixturePath}`);
}
