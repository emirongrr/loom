// Storage layout is a public contract here, and it was the one with no gate.
//
// `src/LoomAccount.sol` says its storage block is "append-only; order is
// consensus-critical". Nothing checked that. A reordered or resized slot passes
// every gate this repository already has: the ABI is unchanged so `abi:check`
// is quiet, behaviour is unchanged so the tests pass, and the gas difference is
// inside the snapshot tolerance. It is invisible until an account reads the
// wrong slot.
//
// It matters most for the two paths that outlive a single deployment. An
// EIP-7702 delegated account keeps its storage and re-points at a new
// implementation, so a moved slot silently reinterprets a live account's
// configuration -- `docs/project/execution-environment-roadmap.md` says the
// 7702 path "works only because the storage block is append-only", which makes
// this discipline load-bearing for the whole upgrade story. And every module
// here is an immutable singleton holding per-account state, so moving a slot
// strands the accounts already using it.
//
// The precedent already exists for one contract: `LoomKeystore`'s slots are
// pinned in `test/unit/OPStackL2KeystoreVerifier.t.sol` because the L2 verifier
// derives proof slots from them. This generalises that to every contract whose
// layout something outside its own source depends on.
//
// `astId` is deliberately dropped. It is an AST node number that moves when
// unrelated lines are added above, so keeping it would make the snapshot churn
// on edits that cannot affect storage.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";
const snapshotPath = join(root, "storage-layout.json");

// Contracts whose slot assignment is depended on from outside their own source:
// the account across implementation generations, and every singleton that keys
// live user state by account address.
//
// `RecoveryIntentBoard` is pinned for the opposite reason: its layout must stay
// *empty*. ADR-0024 accepts a permissionless, unauthenticated `announce` only
// because the contract has no storage for a griefer to grow, so the first slot
// it gains would silently invalidate that argument. Pinning it here makes that
// regression a gate failure rather than a review oversight.
export const PINNED_CONTRACTS = Object.freeze([
  "src/LoomAccount.sol:LoomAccount",
  "src/keystore/LoomKeystore.sol:LoomKeystore",
  "src/hooks/PolicyHook.sol:PolicyHook",
  "src/hooks/VaultHook.sol:VaultHook",
  "src/recovery/RecoveryManager.sol:RecoveryManager",
  "src/recovery/RecoveryIntentBoard.sol:RecoveryIntentBoard",
  "src/recovery/KeystoreSyncRecoveryModule.sol:KeystoreSyncRecoveryModule",
  "src/validators/ECDSAValidator.sol:ECDSAValidator",
  "src/validators/P256Validator.sol:P256Validator",
  "src/validators/MultiP256Validator.sol:MultiP256Validator",
  "src/validators/GranularSessionValidator.sol:GranularSessionValidator",
  "src/validators/ExactCallSessionValidator.sol:ExactCallSessionValidator",
  "src/validators/P256RecoveryValidator.sol:P256RecoveryValidator",
  "src/AppAccountRegistry.sol:AppAccountRegistry"
]);

export function readLayout(target, run = spawnSync) {
  const result = run(forge, ["inspect", target, "storageLayout", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32" && forge.endsWith(".exe") === false
  });
  if (result.status !== 0) {
    throw new Error(`forge inspect failed for ${target}: ${result.stderr || result.stdout}`);
  }
  return normalizeLayout(JSON.parse(result.stdout));
}

/** Slot, offset, label, and type only. Everything else is build noise. */
export function normalizeLayout(layout) {
  return (layout.storage ?? []).map(entry => ({
    label: entry.label,
    slot: Number(entry.slot),
    offset: entry.offset,
    type: stableType(entry.type)
  }));
}

/**
 * Struct and enum types arrive as `t_struct(Name)130_storage`, where the number
 * is an AST node id that moves whenever a line is added above the declaration.
 * Dropping `astId` was not enough -- the same instability leaks back in through
 * the type string, and a snapshot that churns on unrelated edits teaches people
 * to regenerate it without reading it, which is worse than not having one.
 *
 * The struct name is kept because it is the part that carries meaning: renaming
 * or substituting a struct is a change worth reporting.
 */
export function stableType(type) {
  return type.replaceAll(/\)\d+_storage/g, ")_storage");
}

export function buildSnapshot(targets = PINNED_CONTRACTS, run = spawnSync) {
  const contracts = {};
  for (const target of targets) {
    contracts[target] = readLayout(target, run);
  }
  return { version: 1, contracts };
}

/**
 * Differences that would move or reinterpret an existing account's state.
 *
 * Appending is allowed on purpose: the source calls the block append-only, and
 * an appended slot cannot disturb one already written. Everything else --
 * removal, reorder, retype, repacking -- is reported.
 */
export function compareSnapshots(before, after) {
  const problems = [];
  for (const [contract, entries] of Object.entries(before.contracts)) {
    const current = after.contracts[contract];
    if (!current) {
      problems.push(`${contract}: pinned contract is missing from the new layout`);
      continue;
    }
    for (const [index, pinned] of entries.entries()) {
      const found = current[index];
      if (!found) {
        problems.push(`${contract}: slot entry ${index} (${pinned.label}) was removed`);
        continue;
      }
      for (const field of ["label", "slot", "offset", "type"]) {
        if (found[field] !== pinned[field]) {
          problems.push(
            `${contract}: ${pinned.label} ${field} changed ${JSON.stringify(pinned[field])} -> ${JSON.stringify(found[field])}`
          );
        }
      }
    }
  }
  for (const contract of Object.keys(after.contracts)) {
    if (!before.contracts[contract]) problems.push(`${contract}: not pinned; run with --write to record it`);
  }
  return problems;
}

function main() {
  const write = process.argv.includes("--write");
  const snapshot = buildSnapshot();

  if (write) {
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, undefined, 2)}\n`);
    console.log(`storage layout snapshot written for ${Object.keys(snapshot.contracts).length} contracts`);
    return;
  }

  if (!existsSync(snapshotPath)) {
    console.error("storage-layout.json is missing. Generate it with: npm run storage:write");
    process.exit(1);
  }

  const committed = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const problems = compareSnapshots(committed, snapshot);
  if (problems.length > 0) {
    console.error("storage layout changed in a way existing deployments cannot follow:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nAppending a new variable is allowed and only needs `npm run storage:write`." +
        "\nMoving, removing, resizing, or repacking an existing variable is a" +
        "\nstate-incompatible change: it reinterprets storage that deployed accounts" +
        "\nalready hold. Say so in the pull request, record the migration, and only" +
        "\nthen re-record the snapshot."
    );
    process.exit(1);
  }

  console.log(`storage layout ok: ${Object.keys(committed.contracts).length} contracts unchanged`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main();
}
