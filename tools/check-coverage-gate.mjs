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

  console.log(
    `production source coverage: lines ${formatPercent(summary.lines)}, branches ${formatPercent(summary.branches)}`
  );

  if (failures.length !== 0) {
    throw new Error(`coverage gate failed:\n${failures.join("\n")}`);
  }
}

function selfTest() {
  const summary = parseCoverageSummary(`
| script/DeployCore.s.sol | 0.00% (0/3) | 0.00% (0/2) | 100.00% (0/0) | 0.00% (0/1) |
| src/account/LoomAccount.sol | 87.50% (7/8) | 88.89% (8/9) | 60.00% (3/5) | 100.00% (1/1) |
| src/hooks/PolicyHook.sol | 90.00% (9/10) | 90.00% (9/10) | 66.67% (2/3) | 100.00% (1/1) |
`);
  assert.equal(summary.files.length, 2);
  assert.equal(summary.lines, 88.88888888888889);
  assert.equal(summary.branches, 62.5);
  assertGate(summary);
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
