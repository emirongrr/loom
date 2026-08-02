import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertAllowedAuditReport } from "./dependency-audit-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

// The fixture is declared here rather than read from
// `dependency-audit-policy.json`. Taking `policy.exceptions[0]` made the suite
// require a live exception to exist, so an empty exception list - the healthy
// state, and the state this repository is now in - broke the tests for the
// mechanism rather than proving it still works.
//
// This is the exception that was live until the upstream advisories were
// resolved, kept verbatim so the shape under test stays the real one.
const exception = Object.freeze({
  target: "privacy SDK",
  advisory: "GHSA-mh99-v99m-4gvg",
  source: 1124334,
  url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  expiresAt: "2026-08-08T00:00:00Z",
  reason:
    "The vulnerable brace expansion is reachable only through the EJS command-line dependency chain; wallet runtime imports do not load jake, filelist, minimatch, or brace-expansion.",
  isolationTest: "packages/privacy/test/dependency-audit-isolation.test.mjs",
  packages: {
    "@kohaku-eth/privacy-pools": "0.0.1",
    "@fatsolutions/privacy-pools-core-circuits": "1.0.5",
    snarkjs: "0.7.5",
    ejs: "3.1.10",
    jake: "10.9.4",
    filelist: "1.0.6",
    minimatch: "5.1.9",
    "brace-expansion": "2.1.2"
  },
  via: {
    "@kohaku-eth/privacy-pools": "@fatsolutions/privacy-pools-core-circuits",
    "@fatsolutions/privacy-pools-core-circuits": "snarkjs",
    snarkjs: "ejs",
    ejs: "jake",
    jake: "filelist",
    filelist: "minimatch",
    minimatch: "brace-expansion"
  }
});

test("accepts only the reviewed privacy dependency chain before expiry", () => {
  const accepted = assertAllowedAuditReport({
    report: auditReport(),
    lockfile: lockfile(),
    exception,
    root,
    now: new Date("2026-07-25T00:00:00Z")
  });

  assert.deepEqual(accepted, {
    advisory: "GHSA-mh99-v99m-4gvg",
    expiresAt: "2026-08-08T00:00:00Z"
  });
});

test("rejects an unknown advisory or dependency path", () => {
  const report = auditReport();
  report.vulnerabilities["brace-expansion"].via[0].source = 9999999;

  assert.throws(
    () => assertAllowedAuditReport({ report, lockfile: lockfile(), exception, root }),
    /advisory identity changed/
  );
});

test("rejects lockfile drift", () => {
  const lock = lockfile();
  lock.packages["node_modules/minimatch"].version = "10.2.5";

  assert.throws(
    () => assertAllowedAuditReport({ report: auditReport(), lockfile: lock, exception, root }),
    /locked minimatch version changed/
  );
});

test("rejects the reviewed advisory at expiry", () => {
  assert.throws(
    () =>
      assertAllowedAuditReport({
        report: auditReport(),
        lockfile: lockfile(),
        exception,
        root,
        now: new Date("2026-08-08T00:00:00Z")
      }),
    /exception expired/
  );
});

function auditReport() {
  const vulnerabilities = {};
  for (const name of Object.keys(exception.packages)) {
    vulnerabilities[name] = {
      name,
      severity: "high",
      via: exception.via[name] ? [exception.via[name]] : [],
      effects: [],
      nodes: [`node_modules/${name}`],
      fixAvailable: false
    };
  }
  vulnerabilities["brace-expansion"].via = [
    {
      source: exception.source,
      name: "brace-expansion",
      url: exception.url,
      severity: "high"
    }
  ];
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: Object.keys(vulnerabilities).length,
        critical: 0,
        total: Object.keys(vulnerabilities).length
      }
    }
  };
}

function lockfile() {
  return {
    packages: Object.fromEntries(
      Object.entries(exception.packages).map(([name, version]) => [`node_modules/${name}`, { version }])
    )
  };
}
