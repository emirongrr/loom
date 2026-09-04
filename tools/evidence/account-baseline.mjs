import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sha3 from "js-sha3";

const { keccak_256: keccak256 } = sha3;

const root = fileURLToPath(new URL("../../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";
const evidencePath = join(root, "evidence", "baselines", "account-phase0.json");

export const EIP170_RUNTIME_LIMIT = 24_576;
export const REQUIRED_RELEASE_MARGIN = 2_048;
export const TARGET_RELEASE_MARGIN = 4_096;
export const DEFAULT_TARGET = "src/LoomAccount.sol:LoomAccount";

function command(binary, args, run = spawnSync) {
  const result = run(binary, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_PROFILE: "ci" },
    shell: process.platform === "win32" && binary.endsWith(".exe") === false
  });
  if (result.status !== 0) {
    throw new Error(`${binary} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function hexByteLength(value) {
  if (!/^0x[0-9a-f]*$/iu.test(value) || value.length % 2 !== 0) {
    throw new Error("bytecode must be an even-length 0x-prefixed hex value");
  }
  return (value.length - 2) / 2;
}

export function assessRuntimeSize(runtimeBytes) {
  if (!Number.isSafeInteger(runtimeBytes) || runtimeBytes < 0) {
    throw new Error("runtimeBytes must be a non-negative safe integer");
  }
  const marginBytes = EIP170_RUNTIME_LIMIT - runtimeBytes;
  return {
    runtimeBytes,
    limitBytes: EIP170_RUNTIME_LIMIT,
    marginBytes,
    requiredReleaseMarginBytes: REQUIRED_RELEASE_MARGIN,
    targetReleaseMarginBytes: TARGET_RELEASE_MARGIN,
    deployable: marginBytes >= 0,
    releaseReady: marginBytes >= REQUIRED_RELEASE_MARGIN,
    targetReached: marginBytes >= TARGET_RELEASE_MARGIN
  };
}

function sha256File(path) {
  return `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function bytecodeEvidence(value) {
  return {
    bytes: hexByteLength(value),
    keccak256: `0x${keccak256(Buffer.from(value.slice(2), "hex"))}`
  };
}

export function buildBaseline(target = DEFAULT_TARGET, run = spawnSync) {
  const runtime = command(forge, ["inspect", target, "deployedBytecode"], run);
  const initCode = command(forge, ["inspect", target, "bytecode"], run);
  const abi = JSON.parse(command(forge, ["inspect", target, "abi", "--json"], run));
  const storage = JSON.parse(command(forge, ["inspect", target, "storageLayout", "--json"], run));
  const config = JSON.parse(command(forge, ["config", "--json"], run));
  const runtimeSize = assessRuntimeSize(hexByteLength(runtime));

  return {
    schemaVersion: 1,
    purpose: "Behavior-preserving baseline for sovereign account core extraction",
    target,
    source: {
      baselineRevision: command("git", ["rev-parse", "HEAD"], run),
      sourceTree: command("git", ["rev-parse", "HEAD:src"], run),
      packageLockSha256: sha256File(join(root, "package-lock.json")),
      submodules: command("git", ["submodule", "status", "--recursive"], run).split(/\r?\n/u).filter(Boolean)
    },
    compiler: {
      solidity: String(config.solc),
      optimizer: Boolean(config.optimizer),
      optimizerRuns: Number(config.optimizer_runs),
      viaIR: Boolean(config.via_ir),
      evmVersion: String(config.evm_version),
      bytecodeHash: String(config.bytecode_hash),
      profile: "ci"
    },
    bytecode: {
      runtime: { ...bytecodeEvidence(runtime), ...runtimeSize },
      initCode: bytecodeEvidence(initCode)
    },
    compatibility: {
      abiEntries: abi.length,
      storageEntries: storage.storage?.length ?? 0,
      protocolSurfaceSha256: sha256File(join(root, "protocol-surface.json")),
      storageLayoutSha256: sha256File(join(root, "storage-layout.json")),
      gasSnapshotSha256: sha256File(join(root, ".gas-snapshot"))
    }
  };
}

export function baselineDifferences(recorded, current) {
  const paths = [
    ["target"],
    ["source", "sourceTree"],
    ["source", "packageLockSha256"],
    ["source", "submodules"],
    ["compiler"],
    ["bytecode"],
    ["compatibility"]
  ];
  const read = (object, path) => path.reduce((value, key) => value?.[key], object);
  return paths.flatMap(path => {
    const before = read(recorded, path);
    const after = read(current, path);
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [`${path.join(".")} changed ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
  });
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function main() {
  const target = option("--target", DEFAULT_TARGET);
  const baseline = buildBaseline(target);

  if (process.argv.includes("--write")) {
    mkdirSync(join(root, "evidence", "baselines"), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(baseline, undefined, 2)}\n`);
    console.log(`sovereign account baseline written: ${baseline.bytecode.runtime.runtimeBytes} runtime bytes`);
    return;
  }

  if (process.argv.includes("--release")) {
    if (!baseline.bytecode.runtime.releaseReady) {
      console.error(
        `${target} has ${baseline.bytecode.runtime.marginBytes} bytes of EIP-170 margin; ` +
          `${REQUIRED_RELEASE_MARGIN} bytes are required for a new sovereign account generation`
      );
      process.exit(1);
    }
    console.log(`${target} release margin ok: ${baseline.bytecode.runtime.marginBytes} bytes`);
    return;
  }

  if (!existsSync(evidencePath)) {
    console.error("sovereign account baseline is missing; run npm run account:baseline:write");
    process.exit(1);
  }
  const differences = baselineDifferences(JSON.parse(readFileSync(evidencePath, "utf8")), baseline);
  if (differences.length > 0) {
    console.error("sovereign account baseline changed:\n");
    for (const difference of differences) console.error(`  - ${difference}`);
    process.exit(1);
  }
  console.log(
    `sovereign account baseline ok: ${baseline.bytecode.runtime.runtimeBytes} runtime bytes, ` +
      `${baseline.bytecode.runtime.marginBytes} bytes below EIP-170`
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main();
}
