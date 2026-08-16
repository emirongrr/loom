// Some contracts claim to hold no storage. Nothing here enforced that.
//
// `validate-storage-layout.mjs` cannot: it deliberately allows appending,
// because an appended slot cannot disturb one already written. That is right
// for the account and the modules, and useless for a contract whose safety
// argument is that it has *no* slots at all. Adding the first slot to such a
// contract is an append, and the layout gate stays quiet.
//
// The compiler's storage layout also describes declared variables. Inline
// assembly can write a slot that never appears there, so a source-level or
// layout-level check can be satisfied by a contract that still writes state.
//
// This walks the deployed runtime bytecode and asserts no storage-writing
// opcode is reachable in it. That is the artifact that actually runs, it covers
// assembly, and it is decidable without executing anything.
//
// It is deliberately narrow: only contracts whose documented argument depends
// on writing nothing are listed. Adding one here is a claim that the contract
// must never gain state.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";

/**
 * Contracts whose security argument is that they hold no state.
 *
 * `RecoveryIntentBoard` accepts a permissionless, unauthenticated `announce`
 * only because there is no storage for a griefer to grow (ADR-0024). The first
 * slot it gains invalidates that argument, so it must not be able to gain one
 * unnoticed.
 */
export const STORAGE_FREE_CONTRACTS = Object.freeze([
  "src/recovery/RecoveryIntentBoard.sol:RecoveryIntentBoard"
]);

/** Opcodes that write contract state. `TSTORE` is transient, but still state. */
const STORAGE_WRITE_OPCODES = Object.freeze({ 0x55: "SSTORE", 0x5d: "TSTORE" });

/**
 * Strip the CBOR metadata trailer solc appends.
 *
 * Its last two bytes are the trailer length. Metadata is data, not code, and
 * leaving it in would let an arbitrary 0x55 byte inside a source hash look like
 * an SSTORE.
 */
export function stripMetadata(bytes) {
  if (bytes.length < 2) return bytes;
  const length = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const end = bytes.length - 2 - length;
  return end > 0 && end < bytes.length ? bytes.subarray(0, end) : bytes;
}

/**
 * Every storage-writing opcode reachable in `bytes`, by byte offset.
 *
 * Walks the instruction stream rather than searching for a byte value: a
 * `PUSH` immediate can contain 0x55 without being an instruction, and a naive
 * scan would report it. `PUSH0` (0x5f) carries no immediate; `PUSH1`..`PUSH32`
 * (0x60..0x7f) carry one to thirty-two bytes.
 */
export function findStorageWrites(bytes) {
  const found = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const opcode = bytes[index];
    if (STORAGE_WRITE_OPCODES[opcode]) {
      found.push({ offset: index, opcode: STORAGE_WRITE_OPCODES[opcode] });
      continue;
    }
    if (opcode >= 0x60 && opcode <= 0x7f) index += opcode - 0x5f;
  }
  return found;
}

export function readRuntimeBytecode(target, run = spawnSync) {
  const result = run(forge, ["inspect", target, "deployedBytecode", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`forge inspect failed for ${target}: ${result.stderr || result.stdout}`);
  }
  // `forge inspect` prints a bare hex string for this field on some versions and
  // a JSON document on others. Accept either rather than pinning a version.
  const stdout = result.stdout.trim();
  let hex = stdout;
  if (stdout.startsWith("{") || stdout.startsWith("\"")) {
    const raw = JSON.parse(stdout);
    hex = typeof raw === "string" ? raw : raw?.object;
  }
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`forge inspect returned no runtime bytecode for ${target}`);
  }
  if (hex.length <= 2) throw new Error(`${target} has empty runtime bytecode; nothing was verified`);
  return Buffer.from(hex.slice(2), "hex");
}

export function auditContract(target, run = spawnSync) {
  return findStorageWrites(stripMetadata(readRuntimeBytecode(target, run)));
}

function main() {
  const problems = [];
  for (const target of STORAGE_FREE_CONTRACTS) {
    const writes = auditContract(target);
    if (writes.length > 0) {
      problems.push(
        `${target} writes storage: ${writes.map(w => `${w.opcode}@${w.offset}`).join(", ")}`
      );
    }
  }
  if (problems.length > 0) {
    console.error("storage-free contracts must contain no storage-writing opcode:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `storage-free bytecode ok: ${STORAGE_FREE_CONTRACTS.length} contract(s) contain no SSTORE or TSTORE`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
