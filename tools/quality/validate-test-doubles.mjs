import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// `docs/security/test-doubles.md` states, for every test double, what it proves
// and what it only stands in for. That document is only worth reading if it is
// complete: a double added without a row is exactly the case the document
// exists to catch, because nothing else in the suite distinguishes a stub that
// isolates a property from a stub that fakes it.
//
// This checks the mapping is total in both directions. It cannot check that a
// row is *true* - that is review - but it can guarantee no double is missing
// from review's field of view.

const DOUBLES_DIRECTORY = join("test", "mocks");
const DOCUMENT = join("docs", "security", "test-doubles.md");

function doubleNames(base) {
  const directory = join(base, DOUBLES_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith(".sol"))
    .map(name => name.slice(0, -".sol".length))
    .sort();
}

/// Names appearing in a table cell as inline code. The document uses backticks
/// for every contract it names, including the real implementations a row points
/// at, so a name mentioned only in prose does not count as documented.
function documentedNames(source) {
  const documented = new Set();
  for (const line of source.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    for (const match of line.matchAll(/`([A-Za-z0-9_]+)`/gu)) documented.add(match[1]);
  }
  return documented;
}

export function validateTestDoubles(base = process.cwd()) {
  const failures = [];
  const documentPath = join(base, DOCUMENT);
  if (!existsSync(documentPath)) {
    return [`${DOCUMENT} is missing; every test double must be accounted for there`];
  }

  const source = readFileSync(documentPath, "utf8");
  const documented = documentedNames(source);
  const doubles = doubleNames(base);

  if (doubles.length === 0) {
    failures.push(`${DOUBLES_DIRECTORY} contains no doubles; the checker is pointed at the wrong directory`);
  }

  for (const name of doubles) {
    if (!documented.has(name)) {
      failures.push(`${DOUBLES_DIRECTORY}/${name}.sol has no row in ${DOCUMENT}; say what it proves and what it does not`);
    }
  }

  // The reverse direction: a row for a deleted double makes the document claim
  // coverage that no longer exists. Only names that look like doubles are
  // checked, so rows may keep pointing at real implementations elsewhere.
  const known = new Set(doubles);
  for (const name of documented) {
    if (!/^(Mock|Reverting|Reentrant|Deny|GasGriefing|StorageModifying|Rejecting|PaymasterAware|Initializer|Uninstalled|OZ)/u.test(name)) {
      continue;
    }
    if (!known.has(name)) {
      failures.push(`${DOCUMENT} documents "${name}", which no longer exists in ${DOUBLES_DIRECTORY}`);
    }
  }

  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = validateTestDoubles();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`test double: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("test doubles ok: every double in test/mocks is accounted for in docs/security/test-doubles.md");
  }
}
