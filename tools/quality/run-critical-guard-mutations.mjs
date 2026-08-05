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
    search: "if (!_isExecutionEnvironment(msg.sender)) revert OnlyEntryPoint();",
    replacement: "if (false) revert OnlyEntryPoint();",
    testPath: "test/unit/LoomAccount.t.sol",
    testName: "testValidateUserOpRejectsNonEntryPointCallerAndPreservesPrefund",
  },
  {
    // Naming a validator is one step shared by every authorization path -- the
    // ERC-4337 boundary and ERC-1271 both resolve through this helper, so that
    // a second execution environment cannot forget the installed check and the
    // signature path cannot drift from the validation path. This mutant is what
    // proves the check is load-bearing where it now lives.
    id: "account-validator-installed",
    category: "authority",
    source: "src/LoomAccount.sol",
    search: "if (!decoded || !_modules[ModuleType.VALIDATOR][candidate]) return (false, address(0), bytes(\"\"));",
    replacement: "if (false) return (false, address(0), bytes(\"\"));",
    testPath: "test/integration/ExecutionEnvironmentParity.t.sol",
    testName: "testUninstalledValidatorIsRejectedByEveryEnvironment",
  },
  {
    id: "account-initialization-context",
    category: "authority",
    source: "src/LoomAccount.sol",
    search: "if (address(this).code.length != 0) {\n            revert InvalidInitializationContext();",
    replacement: "if (false) {\n            revert InvalidInitializationContext();",
    testPath: "test/integration/EIP7702Integration.t.sol",
    testName: "testExternalCallerCannotInitializeUninitializedDelegatedAccount",
  },
  {
    id: "scheduled-call-delay",
    category: "time",
    source: "src/LoomAccount.sol",
    search: "if (block.timestamp < operation.readyAt) revert OperationNotReady();",
    replacement: "if (false) revert OperationNotReady();",
    testPath: "test/unit/LoomAccount.t.sol",
    testName: "testConfigChangeRequiresAndHonorsDelay",
  },
  {
    id: "scheduled-operation-expiry",
    category: "time",
    source: "src/LoomAccount.sol",
    search: "if (block.timestamp > operation.expiresAt) revert OperationExpired();",
    replacement: "if (false) revert OperationExpired();",
    testPath: "test/integration/ScheduledOperationLifecycle.t.sol",
    testName: "testScheduledOperationExpiresAndCannotBeParkedIndefinitely",
  },
  {
    id: "scheduled-cancellation-instance-nonce",
    category: "replay",
    source: "src/LoomAccount.sol",
    search: "scheduledOperations[operationId] = ScheduledOperation({readyAt: 0, expiresAt: 0, nonce: nonce + 1});",
    replacement: "scheduledOperations[operationId] = ScheduledOperation({readyAt: 0, expiresAt: 0, nonce: nonce});",
    testPath: "test/integration/ScheduledOperationLifecycle.t.sol",
    testName: "testGuardianCancellationCannotBeReplayedAgainstARescheduledOperation",
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
    id: "frozen-recovery-cancellation-config-advance",
    category: "authority",
    source: "src/LoomAccount.sol",
    search: "if (frozen) _advanceConfig(FROZEN_RECOVERY_CANCELLED_HASH);",
    replacement: "if (false) _advanceConfig(FROZEN_RECOVERY_CANCELLED_HASH);",
    testPath: "test/integration/RecoveryManager.t.sol",
    testName: "testFrozenRecoveryCancellationRetiresScheduleAndRearmsGuardians",
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
    id: "policy-hook-mixed-value-spend",
    category: "policy-accounting",
    source: "src/hooks/PolicyHook.sol",
    search: "if (ERC20CallLib.isMixedValueTokenCall(item.callData, item.value)) return type(uint256).max;",
    replacement: "if (false) return type(uint256).max;",
    testPath: "test/integration/MixedValueSpendPolicy.t.sol",
    testName: "testMixedSpendIsNotLowRiskAndCannotDirectExecute",
  },
  {
    id: "vault-cancellation-instance-nonce",
    category: "replay",
    source: "src/hooks/VaultHook.sol",
    search: "PendingWithdrawal({readyAt: 0, expiresAt: 0, configVersion: 0, nonce: nonce + 1});",
    replacement: "PendingWithdrawal({readyAt: 0, expiresAt: 0, configVersion: 0, nonce: nonce});",
    testPath: "test/unit/VaultHook.t.sol",
    testName: "testGuardianCancellationCannotBeReplayedAgainstARescheduledWithdrawal",
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
  {
    id: "session-self-target-grant",
    category: "authority",
    source: "src/validators/GranularSessionValidator.sol",
    search: "|| permission.target == account",
    replacement: "|| false",
    testPath: "test/regression/SessionAdministrativeTargets.t.sol",
    testName: "testSessionPermissionCannotTargetTheAccountItself",
  },
  {
    id: "session-token-selector-agreement",
    category: "authority",
    source: "src/validators/GranularSessionValidator.sol",
    search: "|| ERC20CallLib.isTokenSelector(permission.selector) != (permission.token != address(0))",
    replacement: "|| (permission.token != address(0) && !ERC20CallLib.isTokenSelector(permission.selector))",
    testPath: "test/unit/GranularSessionValidator.t.sol",
    testName: "testTokenSelectorPermissionMustNameTheToken",
  },
  {
    id: "session-module-target",
    category: "authority",
    source: "src/validators/GranularSessionValidator.sol",
    search: "if (_isAdministrativeTarget(account, permission.target)) return false;",
    replacement: "if (false) return false;",
    testPath: "test/regression/SessionAdministrativeTargets.t.sol",
    testName: "testSessionPermissionStopsWorkingOnceItsTargetBecomesAModule",
  },
  {
    id: "keystore-controller-acceptance",
    category: "authority",
    source: "src/keystore/LoomKeystore.sol",
    search: "if (newController == address(0) || msg.sender != newController) revert Unauthorized();",
    replacement: "if (false) revert Unauthorized();",
    testPath: "test/integration/KeystoreSync.t.sol",
    testName: "testControllerTransferNeedsTheRecipientToProveItCanAct",
  },
  {
    id: "hook-order-preserving-removal",
    category: "state-transition",
    source: "src/LoomAccount.sol",
    search: "                for (uint256 j = i + 1; j < length; ++j) {\n                    array[j - 1] = array[j];\n                }",
    replacement: "                array[i] = array[length - 1];",
    testPath: "test/regression/HookComposition.t.sol",
    testName: "testUninstallingAHookDoesNotReorderTheSurvivors",
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
