import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A passing symbolic property proves nothing until you know it can fail. The
// failure mode this guards against is specific and quiet: a property whose
// quantification is narrower than the guard it checks keeps passing after that
// guard is broken, and the report still says PASS.
//
// Each mutant below breaks exactly one guard and names the property that must
// report a counterexample. Unlike the guard mutations over unit tests, a
// mutant here costs a full recompile of the symbolic build (minutes, not
// seconds), so this runs in the formal and nightly workflows rather than in
// `verify:quick`, which runs `--self-test` to check the manifest still lines up
// with the source.

const root = fileURLToPath(new URL("../../", import.meta.url));
const venv = join(root, ".halmos-venv");
const forgeBin = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin");

/// Prefers the pinned local virtualenv created by `npm run halmos:install`, and
/// falls back to a `halmos` already on PATH, which is how CI installs it.
function halmosBin() {
  const local = process.platform === "win32" ? join(venv, "Scripts", "halmos.exe") : join(venv, "bin", "halmos");
  return existsSync(local) ? local : "halmos";
}

const mutants = [
  {
    id: "execution-mode-trailing-bytes",
    category: "execution-mode",
    source: "src/LoomAccount.sol",
    // Enforce only the leading call-type byte, ignoring the requirement that
    // every remaining mode byte is zero.
    search:
      "        if (mode != SINGLE_EXECUTION_MODE && mode != BATCH_EXECUTION_MODE) {\n            revert UnsupportedExecutionMode();\n        }\n        (bytes1 callType,) = ExecutionLib.mode(mode);",
    replacement:
      "        (bytes1 callType,) = ExecutionLib.mode(mode);\n        if (callType != ExecutionLib.CALLTYPE_SINGLE && callType != ExecutionLib.CALLTYPE_BATCH) {\n            revert UnsupportedExecutionMode();\n        }",
    contract: "LoomAccountAuthorityFormal",
    property: "check_UnsupportedExecutionModeNeverExecutes",
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
    const testSource = readFileSync(join(base, "test", "formal", `${mutant.contract}.t.sol`), "utf8");
    assert.match(
      testSource,
      new RegExp(`function\\s+${mutant.property}\\s*\\(`, "u"),
      `${mutant.id}: target property missing`
    );
  }
}

function prepareSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), "loom-property-mutations-"));
  for (const directory of ["src", "test", "fixtures", "script"]) {
    cpSync(join(root, directory), join(sandbox, directory), { recursive: true });
  }
  for (const file of ["foundry.toml", "remappings.txt"]) copyFileSync(join(root, file), join(sandbox, file));
  symlinkSync(join(root, "lib"), join(sandbox, "lib"), process.platform === "win32" ? "junction" : "dir");
  return sandbox;
}

function runHalmos(cwd, mutant) {
  return spawnSync(halmosBin(), ["--contract", mutant.contract, "--function", mutant.property], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: process.platform === "win32" ? `${forgeBin};${process.env.PATH}` : process.env.PATH,
    },
    maxBuffer: 100 * 1024 * 1024,
  });
}

/// Halmos colours its PASS/FAIL markers, so the raw stream carries ANSI escape
/// sequences between the bracket and the property name. Strip them before
/// matching: a killed mutant that is read as inconclusive fails the run for the
/// wrong reason and hides the result it was supposed to produce.
function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/\[[0-9;]*m/gu, "");
}

function reportPathFromArgs() {
  const index = process.argv.indexOf("--report");
  if (index === -1) return undefined;
  if (!process.argv[index + 1]) throw new Error("--report requires a path");
  return join(root, process.argv[index + 1]);
}

function main() {
  validateManifest();
  if (process.argv.includes("--self-test")) {
    console.log(`formal property mutation manifest ok (${mutants.length} mutants)`);
    return;
  }

  const probe = spawnSync(halmosBin(), ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error("Halmos is not available. Run `npm run halmos:install`, or install it on PATH.");
  }

  const reportPath = reportPathFromArgs();
  const startedAt = new Date().toISOString();
  const results = [];
  const sandbox = prepareSandbox();

  try {
    console.log(`running baseline for ${mutants.length} formal property mutants`);
    for (const mutant of mutants) {
      const sourcePath = join(sandbox, mutant.source);
      const original = readFileSync(sourcePath, "utf8");

      // The baseline must pass, or a later failure would prove nothing about
      // the mutation.
      const baseline = runHalmos(sandbox, mutant);
      const baselineOutput = combinedOutput(baseline);
      if (baseline.status !== 0 || !baselineOutput.includes("[PASS]")) {
        process.stdout.write(baselineOutput);
        throw new Error(`${mutant.id}: baseline property did not pass`);
      }

      assert.equal(occurrences(original, mutant.search), 1, `${mutant.id}: sandbox source anchor drifted`);
      writeFileSync(sourcePath, original.replace(mutant.search, mutant.replacement));

      const result = runHalmos(sandbox, mutant);
      const output = combinedOutput(result);
      writeFileSync(sourcePath, original);

      // A killed mutant means halmos produced a counterexample for this exact
      // property. A non-zero exit alone is not enough: a compile error would
      // also be non-zero and would prove nothing.
      const killed = output.includes("Counterexample") && output.includes(`[FAIL] ${mutant.property}`);
      results.push({
        id: mutant.id,
        category: mutant.category,
        source: mutant.source,
        property: `${mutant.contract}.${mutant.property}`,
        status: killed ? "killed" : result.status === 0 ? "survived" : "invalid",
      });
      console.log(`${mutant.id}: ${results.at(-1).status}`);

      if (!killed) {
        process.stdout.write(output);
        throw new Error(
          result.status === 0
            ? `${mutant.id}: mutant survived - the property does not constrain this guard`
            : `${mutant.id}: mutant did not compile or failed outside the target property`
        );
      }
    }
  } finally {
    // Write the report even when a mutant survives: that is exactly the run
    // whose evidence someone will want to read.
    if (reportPath) {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            startedAt,
            finishedAt: new Date().toISOString(),
            total: mutants.length,
            killed: results.filter(result => result.status === "killed").length,
            results,
          },
          null,
          2
        )}\n`
      );
    }
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`formal property mutation score: ${results.filter(r => r.status === "killed").length}/${mutants.length} killed`);
}

main();
