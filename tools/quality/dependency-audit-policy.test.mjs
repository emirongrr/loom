import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { assertAllowedAuditReport } from "./dependency-audit-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const policy = JSON.parse(readFileSync(new URL("./dependency-audit-policy.json", import.meta.url), "utf8"));
const exception = policy.exceptions[0];

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
