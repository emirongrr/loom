import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const localForge = join(root, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe");
const forge = existsSync(localForge) ? localForge : "forge";

const MIN_LINES = 80;
const MIN_BRANCHES = 60;
const CRITICAL_MODULES = [
  "src/LoomAccount.sol",
  "src/LoomAccountFactory.sol",
  "src/adapters/ERC7579ModuleAdapter.sol",
  "src/hooks/PolicyHook.sol",
  "src/hooks/VaultHook.sol",
  "src/keystore/EthereumL1KeystoreVerifier.sol",
  "src/keystore/LoomKeystore.sol",
  "src/recovery/ECDSAGuardianVerifier.sol",
  "src/recovery/ERC1271GuardianVerifier.sol",
  "src/recovery/KeystoreSyncRecoveryModule.sol",
  "src/recovery/P256GuardianVerifier.sol",
  "src/recovery/RecoveryManager.sol",
  "src/validators/ECDSAValidator.sol",
  "src/validators/GranularSessionValidator.sol",
  "src/validators/MultiP256Validator.sol",
  "src/validators/P256Validator.sol",
  "src/validators/ExactCallSessionValidator.sol"
];

const CRITICAL_GROUPS = [
  {
    name: "account-core",
    files: ["src/LoomAccount.sol", "src/LoomAccountFactory.sol"]
  },
  {
    name: "recovery",
    files: [
      "src/recovery/ECDSAGuardianVerifier.sol",
      "src/recovery/ERC1271GuardianVerifier.sol",
      "src/recovery/KeystoreSyncRecoveryModule.sol",
      "src/recovery/P256GuardianVerifier.sol",
      "src/recovery/RecoveryManager.sol"
    ]
  },
  {
    name: "vault",
    files: ["src/hooks/VaultHook.sol"]
  },
  {
    name: "session",
    files: ["src/validators/GranularSessionValidator.sol", "src/validators/ExactCallSessionValidator.sol"]
  }
];

function parseMetric(cell) {
  const match = /(\d+(?:\.\d+)?)%\s*\((\d+)\/(\d+)\)/.exec(cell);
  if (!match) return undefined;
  return {
    percent: Number(match[1]),
    covered: Number(match[2]),
    total: Number(match[3])
  };
}

export function parseCoverageSummary(output) {
  const files = [];

  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes("| src/")) continue;

    const cells = line.split("|").map(cell => cell.trim());
    const file = cells[1];
    if (!file?.startsWith("src/")) continue;

    const lines = parseMetric(cells[2] ?? "");
    const branches = parseMetric(cells[4] ?? "");
    if (!lines || !branches) continue;

    files.push({ file, lines, branches });
  }

  if (files.length === 0) {
    throw new Error("coverage summary did not include any src/ production files");
  }

  const totals = files.reduce(
    (acc, row) => {
      acc.lines.covered += row.lines.covered;
      acc.lines.total += row.lines.total;
      acc.branches.covered += row.branches.covered;
      acc.branches.total += row.branches.total;
      return acc;
    },
    {
      lines: { covered: 0, total: 0 },
      branches: { covered: 0, total: 0 }
    }
  );

  return {
    files,
    lines: percentage(totals.lines),
    branches: percentage(totals.branches)
  };
}

function percentage(metric) {
  if (metric.total === 0) return 100;
  return (metric.covered / metric.total) * 100;
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function assertGate(summary) {
  const failures = [];
  if (summary.lines < MIN_LINES) {
    failures.push(`production source line coverage ${formatPercent(summary.lines)} < ${MIN_LINES}%`);
  }
  if (summary.branches < MIN_BRANCHES) {
    failures.push(`production source branch coverage ${formatPercent(summary.branches)} < ${MIN_BRANCHES}%`);
  }

  const byFile = new Map(summary.files.map(row => [row.file, row]));
  for (const file of CRITICAL_MODULES) {
    const row = byFile.get(file);
    if (!row) {
      failures.push(`critical module coverage missing for ${file}`);
      continue;
    }
    if (row.lines.percent < MIN_LINES) {
      failures.push(`${file} line coverage ${formatPercent(row.lines.percent)} < ${MIN_LINES}%`);
    }
    if (row.branches.percent < MIN_BRANCHES) {
      failures.push(`${file} branch coverage ${formatPercent(row.branches.percent)} < ${MIN_BRANCHES}%`);
    }
  }

  for (const group of CRITICAL_GROUPS) {
    const groupSummary = summarizeGroup(group, byFile, failures);
    if (!groupSummary) continue;
    if (groupSummary.lines < MIN_LINES) {
      failures.push(`${group.name} group line coverage ${formatPercent(groupSummary.lines)} < ${MIN_LINES}%`);
    }
    if (groupSummary.branches < MIN_BRANCHES) {
      failures.push(`${group.name} group branch coverage ${formatPercent(groupSummary.branches)} < ${MIN_BRANCHES}%`);
    }
  }

  console.log(
    `production source coverage: lines ${formatPercent(summary.lines)}, branches ${formatPercent(summary.branches)}`
  );
  console.log(`critical module coverage gate: ${CRITICAL_MODULES.length} modules at ${MIN_LINES}%/${MIN_BRANCHES}%`);
  console.log(`critical group coverage gate: ${CRITICAL_GROUPS.map(group => group.name).join(", ")}`);

  if (failures.length !== 0) {
    throw new Error(`coverage gate failed:\n${failures.join("\n")}`);
  }
}

function summarizeGroup(group, byFile, failures) {
  const totals = {
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 }
  };
  for (const file of group.files) {
    const row = byFile.get(file);
    if (!row) {
      failures.push(`${group.name} group coverage missing for ${file}`);
      return undefined;
    }
    totals.lines.covered += row.lines.covered;
    totals.lines.total += row.lines.total;
    totals.branches.covered += row.branches.covered;
    totals.branches.total += row.branches.total;
  }
  return {
    lines: percentage(totals.lines),
    branches: percentage(totals.branches)
  };
}

function selfTest() {
  const summary = parseCoverageSummary(`
| script/DeployCore.s.sol | 0.00% (0/3) | 0.00% (0/2) | 100.00% (0/0) | 0.00% (0/1) |
| src/LoomAccount.sol | 87.50% (7/8) | 88.89% (8/9) | 60.00% (3/5) | 100.00% (1/1) |
| src/LoomAccountFactory.sol | 100.00% (3/3) | 100.00% (3/3) | 75.00% (3/4) | 100.00% (1/1) |
| src/adapters/ERC7579ModuleAdapter.sol | 84.62% (11/13) | 71.43% (10/14) | 75.00% (3/4) | 75.00% (3/4) |
| src/hooks/PolicyHook.sol | 90.00% (9/10) | 90.00% (9/10) | 66.67% (2/3) | 100.00% (1/1) |
| src/hooks/VaultHook.sol | 93.02% (120/129) | 90.40% (160/177) | 63.16% (24/38) | 94.74% (18/19) |
| src/keystore/EthereumL1KeystoreVerifier.sol | 100.00% (13/13) | 100.00% (25/25) | 100.00% (4/4) | 100.00% (2/2) |
| src/keystore/LoomKeystore.sol | 92.50% (37/40) | 86.27% (44/51) | 60.00% (6/10) | 85.71% (6/7) |
| src/recovery/ECDSAGuardianVerifier.sol | 100.00% (3/3) | 100.00% (7/7) | 100.00% (0/0) | 100.00% (1/1) |
| src/recovery/ERC1271GuardianVerifier.sol | 100.00% (8/8) | 100.00% (11/11) | 100.00% (3/3) | 100.00% (1/1) |
| src/recovery/KeystoreSyncRecoveryModule.sol | 96.81% (91/94) | 94.90% (149/157) | 60.00% (12/20) | 100.00% (14/14) |
| src/recovery/P256GuardianVerifier.sol | 100.00% (8/8) | 100.00% (8/8) | 100.00% (0/0) | 100.00% (2/2) |
| src/recovery/RecoveryManager.sol | 97.67% (84/86) | 96.53% (139/144) | 75.00% (15/20) | 100.00% (12/12) |
| src/validators/ECDSAValidator.sol | 91.67% (33/36) | 86.96% (40/46) | 71.43% (5/7) | 100.00% (9/9) |
| src/validators/GranularSessionValidator.sol | 93.33% (70/75) | 90.00% (117/130) | 68.75% (22/32) | 100.00% (9/9) |
| src/validators/MultiP256Validator.sol | 91.67% (77/84) | 89.16% (115/129) | 64.29% (18/28) | 100.00% (14/14) |
| src/validators/P256Validator.sol | 91.30% (42/46) | 84.91% (45/53) | 62.50% (5/8) | 100.00% (9/9) |
| src/validators/ExactCallSessionValidator.sol | 92.31% (36/39) | 86.00% (43/50) | 60.00% (6/10) | 100.00% (8/8) |
`);
  assert.equal(summary.files.length, 17);
  assert.equal(Math.round(summary.lines * 100) / 100, 93.81);
  assert.equal(Math.round(summary.branches * 100) / 100, 66.84);
  assertGate(summary);

  assert.throws(
    () =>
      assertGate({
        ...summary,
        files: summary.files.map(row =>
          row.file === "src/LoomAccount.sol"
            ? { ...row, branches: { ...row.branches, percent: 59.99 } }
            : row
        )
      }),
    /src\/account\/LoomAccount\.sol branch coverage 59\.99% < 60%/u
  );
  assert.throws(
    () =>
      assertGate({
        ...summary,
        files: summary.files.filter(row => row.file !== "src/validators/ExactCallSessionValidator.sol")
      }),
    /critical module coverage missing for src\/validators\/ExactCallSessionValidator\.sol/u
  );
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const result = spawnSync(
    forge,
    ["coverage", "--ir-minimum", "--report", "summary", "--skip", "test/formal/**"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 200 * 1024 * 1024
    }
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`forge coverage failed with status ${result.status}`);
  }

  assertGate(parseCoverageSummary(`${result.stdout}\n${result.stderr}`));
}

main();
