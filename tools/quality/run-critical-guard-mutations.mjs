import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";

const mutants = [
  {
    id: "account-entrypoint-caller",
    category: "authority",
    source: "src/LoomAccount.sol",
    search: "if (msg.sender != entryPoint) revert OnlyEntryPoint();",
    replacement: "if (false) revert OnlyEntryPoint();",
    testPath: "test/unit/LoomAccount.t.sol",
    testName: "testValidateUserOpRejectsNonEntryPointCallerAndPreservesPrefund",
  },
  {
    id: "scheduled-call-delay",
    category: "time",
    source: "src/LoomAccount.sol",
    search: "if (block.timestamp < readyAt) revert OperationNotReady();",
    replacement: "if (false) revert OperationNotReady();",
    testPath: "test/unit/LoomAccount.t.sol",
    testName: "testConfigChangeRequiresAndHonorsDelay",
  },
  {
    id: "migration-config-snapshot",
    category: "stale-authority",
    source: "src/LoomAccount.sol",
    search: "block.timestamp > migration.expiresAt || configVersion != migration.configVersion",
    replacement: "block.timestamp > migration.expiresAt",
    testPath: "test/integration/SovereignMigration.t.sol",
    testName: "testMigrationRejectsWrongCallsDestinationConfigExpiryAndStaleConfig",
  },
  {
    id: "migration-state-consumption",
    category: "state-transition",
    source: "src/LoomAccount.sol",
    search:
      "bytes32 migrationId = migrationIdFor(migration);\n        delete pendingMigration;\n        ++migrationNonce;\n\n        bytes memory executionCalldata",
    replacement:
      "bytes32 migrationId = migrationIdFor(migration);\n        ++migrationNonce;\n\n        bytes memory executionCalldata",
    testPath: "test/integration/SovereignMigration.t.sol",
    testName: "testMigrationIsDelayedPermissionlessAndDestinationBound",
  },
  {
    id: "recovery-config-snapshot",
    category: "stale-authority",
    source: "src/recovery/RecoveryManager.sol",
    search: "if (ILoomAccount(account).configVersion() != pending.configVersion) revert InvalidRecovery();",
    replacement: "if (false) revert InvalidRecovery();",
    testPath: "test/integration/RecoveryManager.t.sol",
    testName: "testConfigChangeInvalidatesAndExpiryBlocksRecovery",
  },
  {
    id: "vault-withdrawal-delay",
    category: "time",
    source: "src/hooks/VaultHook.sol",
    search: "if (block.timestamp < pending.readyAt) revert WithdrawalNotReady();",
    replacement: "if (false) revert WithdrawalNotReady();",
    testPath: "test/unit/VaultHook.t.sol",
    testName: "testDelayedVaultWithdrawalIsExactAndAtomic",
  },
];

function occurrences(source, search) {
  return source.split(search).length - 1;
}

function validateManifest(base = root) {
  assert.equal(new Set(mutants.map(mutant => mutant.id)).size, mutants.length, "mutation ids must be unique");
  for (const mutant of mutants) {
    const source = readFileSync(join(base, mutant.source), "utf8");
    assert.equal(occurrences(source, mutant.search), 1, `${mutant.id}: source anchor must occur exactly once`);
    const testSource = readFileSync(join(base, mutant.testPath), "utf8");
    assert.match(testSource, new RegExp(`function\\s+${mutant.testName}\\s*\\(`, "u"), `${mutant.id}: target test missing`);
  }
}

function prepareSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), "loom-critical-mutations-"));
  for (const directory of ["src", "test", "fixtures", "script"]) {
    cpSync(join(root, directory), join(sandbox, directory), { recursive: true });
  }
  for (const file of ["foundry.toml", "remappings.txt"]) copyFileSync(join(root, file), join(sandbox, file));
  symlinkSync(join(root, "lib"), join(sandbox, "lib"), process.platform === "win32" ? "junction" : "dir");
  return sandbox;
}

function runForge(cwd, args) {
  return spawnSync(forge, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_PROFILE: "default" },
    maxBuffer: 100 * 1024 * 1024,
  });
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function gitCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function reportPathFromArgs() {
  const index = process.argv.indexOf("--report");
  if (index === -1) return undefined;
  if (!process.argv[index + 1]) throw new Error("--report requires a path");
  return join(root, process.argv[index + 1]);
}

function writeReport(path, report) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function main() {
  validateManifest();
  if (process.argv.includes("--self-test")) {
    console.log(`critical guard mutation manifest ok (${mutants.length} mutants)`);
    return;
  }

  const reportPath = reportPathFromArgs();
  const startedAt = new Date().toISOString();
  const results = [];
  const sandbox = prepareSandbox();
  try {
    const baselinePattern = [...new Set(mutants.map(mutant => mutant.testName))].join("|");
    console.log(`running baseline for ${mutants.length} critical guard mutants`);
    const baseline = runForge(sandbox, ["test", "--match-test", baselinePattern]);
    if (baseline.status !== 0) {
      process.stdout.write(baseline.stdout ?? "");
      process.stderr.write(baseline.stderr ?? "");
      throw new Error("critical guard mutation baseline failed");
    }
    const baselineOutput = combinedOutput(baseline);
    for (const mutant of mutants) {
      assert.ok(baselineOutput.includes(`${mutant.testName}()`), `${mutant.id}: baseline did not execute target test`);
    }

    for (const mutant of mutants) {
      const sourcePath = join(sandbox, mutant.source);
      const original = readFileSync(sourcePath, "utf8");
      assert.equal(occurrences(original, mutant.search), 1, `${mutant.id}: sandbox source anchor drifted`);
      writeFileSync(sourcePath, original.replace(mutant.search, mutant.replacement));

      const result = runForge(sandbox, [
        "test",
        "--force",
        "--match-test",
        mutant.testName,
        "-vv",
      ]);
      const output = combinedOutput(result);
      writeFileSync(sourcePath, original);

      const failedInTargetTest = result.status !== 0 && output.includes("[FAIL:") && output.includes(mutant.testName);
      results.push({
        id: mutant.id,
        category: mutant.category,
        source: mutant.source,
        test: `${mutant.testPath}:${mutant.testName}`,
        status: failedInTargetTest ? "killed" : result.status === 0 ? "survived" : "invalid",
      });
      console.log(`${mutant.id}: ${results.at(-1).status}`);

      if (!failedInTargetTest) {
        process.stdout.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? "");
        throw new Error(
          result.status === 0
            ? `${mutant.id}: mutant survived`
            : `${mutant.id}: mutant did not compile or failed outside the target test`,
        );
      }
    }
  } finally {
    const report = {
      schemaVersion: 1,
      commit: gitCommit(),
      startedAt,
      finishedAt: new Date().toISOString(),
      total: mutants.length,
      killed: results.filter(result => result.status === "killed").length,
      results,
    };
    writeReport(reportPath, report);
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`critical guard mutation score: ${results.length}/${mutants.length} killed`);
}

main();
