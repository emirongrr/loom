import { existsSync } from "node:fs";
import { join } from "node:path";

export function assertAllowedAuditReport({ report, lockfile, exception, root, now = new Date() }) {
  if (!report || report.auditReportVersion !== 2 || !report.vulnerabilities) {
    throw new Error("unsupported npm audit report");
  }
  if (!exception) {
    throw new Error("missing dependency audit exception");
  }

  const expiry = new Date(exception.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || now >= expiry) {
    throw new Error(`dependency audit exception expired at ${exception.expiresAt}`);
  }
  if (!exception.isolationTest || !existsSync(join(root, exception.isolationTest))) {
    throw new Error("dependency audit isolation test is missing");
  }

  if (exception.profile === "exact-advisory-graph-v1") {
    return assertExactAdvisoryGraph({ report, lockfile, exception });
  }
  if (exception.target !== "privacy SDK") {
    throw new Error("unsupported dependency audit exception profile");
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

/**
 * An exception that pins what we control, and tolerates what we do not.
 *
 * The graph is npm's opinion, and it moves without us: the same lockfile
 * produced eleven vulnerable packages, then eight, then five, as advisory data
 * changed upstream. Requiring an exact match meant re-recording every time,
 * which is noise that teaches people to re-record without looking -- the
 * opposite of what a gate is for.
 *
 * So the two questions are separated.
 *
 * Whether *our* dependencies moved is checked against every pinned package,
 * including ones no longer flagged. That is the check that must never lapse,
 * and losing it was the real risk in trimming the list: a package that leaves
 * the advisory graph would otherwise stop having its version pinned at all.
 *
 * Whether a *new* vulnerability appeared is checked by refusing any flagged
 * package that is not pinned. A graph that shrinks passes; one that grows does
 * not, because a package arriving in it is a finding nobody has reviewed.
 */
function assertExactAdvisoryGraph({ report, lockfile, exception }) {
  const pinned = Object.entries(exception.packages);
  const flagged = Object.keys(report.vulnerabilities).sort();

  // Anything flagged that nobody pinned is a new finding, whatever its severity.
  const unreviewed = flagged.filter(name => !exception.packages[name]);
  if (unreviewed.length > 0) {
    throw new Error(`audit found packages this exception does not cover: ${unreviewed.join(", ")}`);
  }

  const actualAdvisories = [];
  for (const [name, expected] of pinned) {
    // Checked for every pinned package, flagged or not: this is the question
    // the gate exists to answer.
    const locked = lockfile.packages?.[expected.path]?.version;
    if (locked !== expected.version) {
      throw new Error(`locked ${name} version changed: expected ${expected.version}, received ${locked ?? "missing"}`);
    }

    const finding = report.vulnerabilities[name];
    if (!finding) continue;

    const actualVia = finding.via?.filter(item => typeof item === "string").sort() ?? [];
    const expectedVia = [...(exception.via[name] ?? [])].sort();
    // A path that grew is a new way in and is refused; one that shrank is the
    // registry withdrawing a claim, and matches the graph shrinking.
    const added = actualVia.filter(item => !expectedVia.includes(item));
    if (added.length > 0) throw new Error(`audit path grew for ${name}: ${added.join(", ")}`);
    assertSameList([...(finding.nodes ?? [])].sort(), [expected.path], `audit node changed for ${name}`);

    for (const advisory of finding.via?.filter(item => typeof item === "object") ?? []) {
      actualAdvisories.push(`${name}:${advisory.source}:${advisory.url}`);
    }
  }

  const expectedAdvisories = exception.advisories.map(item => {
    if (!item.url.endsWith(item.advisory)) throw new Error("configured audit advisory identity is invalid");
    return `${item.package}:${item.source}:${item.url}`;
  });
  const unexpected = actualAdvisories.filter(item => !expectedAdvisories.includes(item));
  if (unexpected.length > 0) throw new Error(`audit advisory identity changed: ${unexpected.join(", ")}`);

  const counts = report.metadata?.vulnerabilities;
  if (
    counts?.total !== flagged.length ||
    counts.high !== flagged.length ||
    counts.info !== 0 ||
    counts.low !== 0 ||
    counts.moderate !== 0 ||
    counts.critical !== 0
  ) {
    throw new Error("audit severity counts changed");
  }

  return Object.freeze({
    advisory: exception.advisories.map(item => item.advisory).join(", "),
    expiresAt: exception.expiresAt
  });
}

function assertSameList(actual, expected, message) {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${message}: expected ${expected.join(", ")}; received ${actual.join(", ")}`);
  }
}
