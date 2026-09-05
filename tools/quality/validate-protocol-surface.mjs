// The wire surface, recorded so a change to it cannot be quiet.
//
// `abi:check` proves the committed ABI matches the build. That is freshness,
// not compatibility: regenerating makes the diff, and whether anyone notices
// what moved is left to review. A renamed parameter is invisible in the tests, a
// changed error signature breaks every decoder downstream, and an edited EIP-712
// type string changes every digest an installed validator will accept while the
// ABI stays byte-identical.
//
// So this records the values a consumer actually binds to -- function selectors,
// outputs and mutability; event topics and indexed layout; error selectors; and
// typed-data schemas. Every addition must be recorded so it is protected from a
// later removal, while removals and changes are reported as wire-breaking.
//
// Typed data is recorded as the *string being hashed*, not only its keccak.
// `keccak256("Freeze(bytes32 guardianLeaf,uint256 nonce,uint64 configVersion)")`
// changing to a different hash tells a reviewer nothing; the string diff tells
// them a field moved.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sha3 from "js-sha3";

const { keccak_256: keccak256 } = sha3;

const root = fileURLToPath(new URL("../../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";
const snapshotPath = join(root, "protocol-surface.json");

/** Contracts and interfaces a downstream consumer encodes against. */
export const SURFACE_CONTRACTS = Object.freeze([
  "src/LoomAccount.sol:LoomAccount",
  "src/MigrationModule.sol:MigrationModule",
  "src/LoomAccountFactory.sol:LoomAccountFactory",
  "src/LoomAccountProxy.sol:LoomAccountProxy",
  "src/AppAccountRegistry.sol:AppAccountRegistry",
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
  "src/validators/P256RecoveryValidatorFactory.sol:P256RecoveryValidatorFactory"
]);

/** Canonical ABI type, expanding tuples the way selector hashing requires. */
export function canonicalType(input) {
  if (!input.type.startsWith("tuple")) return input.type;
  const inner = (input.components ?? []).map(canonicalType).join(",");
  return `(${inner})${input.type.slice("tuple".length)}`;
}

export function signatureOf(item) {
  return `${item.name}(${(item.inputs ?? []).map(canonicalType).join(",")})`;
}

const hash = value => `0x${keccak256(value)}`;
const selector = value => hash(value).slice(0, 10);

/** Functions, events, and errors keyed by signature, so a diff reads as prose. */
export function surfaceOf(abi) {
  const functions = {};
  const functionOutputs = {};
  const functionMutability = {};
  const events = {};
  const eventLayouts = {};
  const errors = {};
  for (const item of abi) {
    if (item.type === "function") {
      const signature = signatureOf(item);
      functions[signature] = selector(signature);
      functionOutputs[signature] = (item.outputs ?? []).map(canonicalType);
      functionMutability[signature] = item.stateMutability ?? "";
    } else if (item.type === "event") {
      const signature = signatureOf(item);
      events[signature] = hash(signature);
      eventLayouts[signature] = {
        anonymous: item.anonymous === true,
        indexed: (item.inputs ?? []).map(input => input.indexed === true)
      };
    }
    else if (item.type === "error") errors[signatureOf(item)] = selector(signatureOf(item));
  }
  return {
    functions: sortKeys(functions),
    functionOutputs: sortKeys(functionOutputs),
    functionMutability: sortKeys(functionMutability),
    events: sortKeys(events),
    eventLayouts: sortKeys(eventLayouts),
    errors: sortKeys(errors)
  };
}

/** Two signatures sharing one 4-byte selector: the caller cannot be routed. */
export function selectorCollisions(surface) {
  const collisions = [];
  for (const kind of ["functions", "errors"]) {
    const seen = new Map();
    for (const [signature, value] of Object.entries(surface[kind])) {
      const previous = seen.get(value);
      if (previous) collisions.push(`${kind}: ${previous} and ${signature} share selector ${value}`);
      else seen.set(value, signature);
    }
  }
  return collisions;
}

/**
 * EIP-712 type strings, read from source rather than from the compiled value.
 *
 * The constant is what the contract hashes, so the string is the schema. A
 * reviewer comparing two 32-byte hashes learns nothing; comparing two type
 * strings sees the field that moved.
 */
export function typeHashesIn(source) {
  const found = {};
  const pattern = /(\w*TYPEHASH)\s*=\s*keccak256\(\s*"([^"]+)"\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    found[match[1]] = { schema: match[2], hash: hash(match[2]) };
  }
  return found;
}

function solidityFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? solidityFiles(path) : path.endsWith(".sol") ? [path] : [];
  });
}

function sortKeys(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1)));
}

export function buildSnapshot(targets = SURFACE_CONTRACTS, run = spawnSync) {
  const contracts = {};
  for (const target of targets) {
    const result = run(forge, ["inspect", target, "abi", "--json"], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`forge inspect failed for ${target}: ${result.stderr || result.stdout}`);
    contracts[target] = surfaceOf(JSON.parse(result.stdout));
  }

  const typedData = {};
  for (const file of solidityFiles(join(root, "src"))) {
    const found = typeHashesIn(readFileSync(file, "utf8"));
    const relative = file.slice(root.length).replaceAll("\\", "/");
    if (Object.keys(found).length > 0) typedData[relative] = sortKeys(found);
  }

  return { version: 2, contracts, typedData: sortKeys(typedData) };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Every change requires review; removals and changes are wire-breaking. */
export function compareSnapshots(before, after) {
  const problems = [];

  if (before.version !== after.version) {
    problems.push(`snapshot version changed ${before.version ?? "missing"} -> ${after.version ?? "missing"}`);
  }

  for (const [contract, kinds] of Object.entries(before.contracts)) {
    const current = after.contracts[contract];
    if (!current) {
      problems.push(`${contract}: contract disappeared from the recorded surface`);
      continue;
    }
    for (const [kind, entries] of Object.entries(kinds)) {
      for (const [signature, value] of Object.entries(entries)) {
        const now = current[kind]?.[signature];
        if (now === undefined) problems.push(`${contract}: ${kind.slice(0, -1)} ${signature} was removed`);
        else if (!sameValue(now, value)) {
          problems.push(
            `${contract}: ${kind} ${signature} changed ${JSON.stringify(value)} -> ${JSON.stringify(now)}`
          );
        }
      }
    }
  }

  for (const [contract, kinds] of Object.entries(after.contracts)) {
    const recorded = before.contracts[contract];
    if (!recorded) {
      problems.push(`${contract}: contract was added but is not recorded`);
      continue;
    }
    for (const [kind, entries] of Object.entries(kinds)) {
      for (const signature of Object.keys(entries)) {
        if (recorded[kind]?.[signature] === undefined) {
          problems.push(`${contract}: ${kind.slice(0, -1)} ${signature} was added but is not recorded`);
        }
      }
    }
  }

  for (const [file, entries] of Object.entries(before.typedData)) {
    const current = after.typedData[file];
    for (const [name, pinned] of Object.entries(entries)) {
      const now = current?.[name];
      if (!now) problems.push(`${file}: ${name} was removed`);
      else if (now.schema !== pinned.schema) {
        problems.push(`${file}: ${name} schema changed\n      was: ${pinned.schema}\n      now: ${now.schema}`);
      } else if (now.hash !== pinned.hash) {
        problems.push(`${file}: ${name} hash changed ${pinned.hash} -> ${now.hash}`);
      }
    }
  }

  for (const [file, entries] of Object.entries(after.typedData)) {
    const recorded = before.typedData[file];
    for (const name of Object.keys(entries)) {
      if (!recorded?.[name]) problems.push(`${file}: ${name} was added but is not recorded`);
    }
  }

  return problems;
}

function main() {
  const write = process.argv.includes("--write");
  const snapshot = buildSnapshot();

  const collisions = Object.entries(snapshot.contracts).flatMap(([contract, surface]) =>
    selectorCollisions(surface).map(problem => `${contract}: ${problem}`)
  );
  if (collisions.length > 0) {
    console.error("selector collision:\n");
    for (const collision of collisions) console.error(`  - ${collision}`);
    process.exit(1);
  }

  if (write) {
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, undefined, 2)}\n`);
    console.log(`protocol surface written for ${Object.keys(snapshot.contracts).length} contracts`);
    return;
  }

  if (!existsSync(snapshotPath)) {
    console.error("protocol-surface.json is missing. Generate it with: npm run surface:write");
    process.exit(1);
  }

  const problems = compareSnapshots(JSON.parse(readFileSync(snapshotPath, "utf8")), snapshot);
  if (problems.length > 0) {
    console.error("the protocol surface changed in a way consumers cannot follow:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
        "\nAdditive changes must be recorded so a later removal cannot become invisible." +
        "\nRemoving or changing a recorded item breaks consumers that already encode it:" +
        "\nSDK, CLI, examples, and any signature already produced against the old" +
        "\nschema. Declare it as wire/API breaking, write the migration, and only" +
        "\nthen re-record with `npm run surface:write`."
    );
    process.exit(1);
  }

  console.log(`protocol surface ok: ${Object.keys(snapshot.contracts).length} contracts, no removals or changes`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main();
}
