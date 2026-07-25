import { existsSync } from "node:fs";
import { join } from "node:path";

export function assertAllowedAuditReport({ report, lockfile, exception, root, now = new Date() }) {
  if (!report || report.auditReportVersion !== 2 || !report.vulnerabilities) {
    throw new Error("unsupported npm audit report");
  }
  if (!exception || exception.target !== "privacy SDK") {
    throw new Error("missing privacy SDK audit exception");
  }

  const expiry = new Date(exception.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || now >= expiry) {
    throw new Error(`dependency audit exception expired at ${exception.expiresAt}`);
  }
  if (!exception.isolationTest || !existsSync(join(root, exception.isolationTest))) {
    throw new Error("dependency audit isolation test is missing");
  }

  const expectedPackages = Object.keys(exception.packages).sort();
  const actualPackages = Object.keys(report.vulnerabilities).sort();
  assertSameList(actualPackages, expectedPackages, "audit package set changed");

  const rootFinding = report.vulnerabilities["brace-expansion"];
  const advisories = rootFinding?.via?.filter(item => typeof item === "object") ?? [];
  if (
    advisories.length !== 1 ||
    advisories[0].source !== exception.source ||
    advisories[0].url !== exception.url ||
    !advisories[0].url.endsWith(exception.advisory)
  ) {
    throw new Error("audit advisory identity changed");
  }

  for (const [name, expectedVia] of Object.entries(exception.via)) {
    const finding = report.vulnerabilities[name];
    const namedVia = finding?.via?.filter(item => typeof item === "string") ?? [];
    assertSameList(namedVia, [expectedVia], `audit path changed for ${name}`);
  }

  for (const [name, version] of Object.entries(exception.packages)) {
    const locked = lockfile.packages?.[`node_modules/${name}`]?.version;
    if (locked !== version) {
      throw new Error(`locked ${name} version changed: expected ${version}, received ${locked ?? "missing"}`);
    }
  }

  const counts = report.metadata?.vulnerabilities;
  if (
    counts?.total !== expectedPackages.length ||
    counts.high !== expectedPackages.length ||
    counts.info !== 0 ||
    counts.low !== 0 ||
    counts.moderate !== 0 ||
    counts.critical !== 0
  ) {
    throw new Error("audit severity counts changed");
  }

  return Object.freeze({ advisory: exception.advisory, expiresAt: exception.expiresAt });
}

function assertSameList(actual, expected, message) {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${message}: expected ${expected.join(", ")}; received ${actual.join(", ")}`);
  }
}
