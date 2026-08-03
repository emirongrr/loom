import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Documentation states contract limits as numbers: "`MAX_HOOKS` is 8",
// "`MIN_CONFIG_DELAY` (3 days)", "`MAX_REVERT_DATA_LENGTH` (2,048 bytes)".
// Nothing connected those numbers to the constants they describe, so changing a
// limit in Solidity left the prose asserting the old one - and a wrong number in
// a security document is worse than no number, because a reader budgets against
// it.
//
// This reads every named numeric constant out of `src/` and every place the docs
// state a value for one, and requires them to agree. It deliberately does not
// try to understand prose: it only looks at the two shapes above, both of which
// name the constant explicitly.

const UNITS = Object.freeze({
  second: 1n,
  seconds: 1n,
  minute: 60n,
  minutes: 60n,
  hour: 3600n,
  hours: 3600n,
  day: 86_400n,
  days: 86_400n,
  week: 604_800n,
  weeks: 604_800n,
});

// Prose writes "1 hour" where Solidity writes "1 hours", so both spellings have
// to be accepted or every singular duration reads as a bare number.
const UNIT_PATTERN = "seconds?|minutes?|hours?|days?|weeks?";

// Docs wrap constant names in inline code. Kept as a named piece so the
// patterns below stay readable inside template literals.
const BACKTICK = "`";

function walk(directory, extension) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(name => {
    if (name.startsWith(".")) return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path, extension) : path.endsWith(extension) ? [path] : [];
  });
}

/// Parses the right-hand side of a constant declaration into a number, or
/// returns undefined when it is not a plain numeric literal. Aliases such as
/// `MAX_VALIDATORS = ValidatorSetLib.MAX_VALIDATORS` resolve to the underlying
/// declaration because both names are collected and the alias yields no value of
/// its own.
function parseValue(expression) {
  const text = expression.trim().replace(/_/gu, "");
  const duration = text.match(new RegExp(String.raw`^([0-9]+)\s+(${UNIT_PATTERN})$`, "u"));
  if (duration) return { amount: BigInt(duration[1]) * UNITS[duration[2]], unit: duration[2] };
  if (/^[0-9]+$/u.test(text)) return { amount: BigInt(text), unit: undefined };
  if (/^0x[0-9a-fA-F]+$/u.test(text)) return { amount: BigInt(text), unit: undefined };
  return undefined;
}

export function contractConstants(base = process.cwd()) {
  const constants = new Map();
  for (const path of walk(join(base, "src"), ".sol")) {
    const source = readFileSync(path, "utf8");
    const pattern = /\b(?:uint\d*|int\d*|bytes\d*)\s+(?:public|internal|private)\s+constant\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/gu;
    for (const match of source.matchAll(pattern)) {
      const value = parseValue(match[2]);
      if (!value) continue;
      const name = match[1];
      const existing = constants.get(name);
      // A name declared twice with different values would make any documented
      // number ambiguous; surface it rather than picking one.
      if (existing && existing.amount !== value.amount) {
        existing.conflicting = true;
        continue;
      }
      if (!existing) {
        constants.set(name, { ...value, source: relative(base, path).split(sep).join("/") });
      }
    }
  }
  return constants;
}

/// Both documented shapes: "`NAME` is 8" and "`NAME` (3 days)". The value may
/// carry thousands separators and an optional unit.
const DOC_PATTERNS = [
  new RegExp(String.raw`${BACKTICK}([A-Z][A-Z0-9_]{2,})${BACKTICK}\s+is\s+([0-9][0-9,]*)\s*(${UNIT_PATTERN})?`, "gu"),
  new RegExp(String.raw`${BACKTICK}([A-Z][A-Z0-9_]{2,})${BACKTICK}\s*\(\s*([0-9][0-9,]*)\s*(${UNIT_PATTERN})?`, "gu"),
];

export function validateDocConstants(base = process.cwd()) {
  const failures = [];
  const constants = contractConstants(base);

  for (const path of walk(join(base, "docs"), ".md")) {
    const relativePath = relative(base, path).split(sep).join("/");
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n");

    lines.forEach((line, index) => {
      for (const pattern of DOC_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          const [, name, rawNumber, unit] = match;
          const declared = constants.get(name);
          if (!declared) continue;
          if (declared.conflicting) {
            failures.push(
              `${relativePath}:${index + 1}: \`${name}\` is declared with conflicting values in src; document it only once it is unambiguous`
            );
            continue;
          }

          const number = BigInt(rawNumber.replace(/,/gu, ""));
          const stated = unit ? number * UNITS[unit] : number;
          if (stated !== declared.amount) {
            const shown = declared.unit ? `${declared.amount / UNITS[declared.unit]} ${declared.unit}` : declared.amount;
            failures.push(
              `${relativePath}:${index + 1}: \`${name}\` is ${shown} in ${declared.source}, but this line states ${rawNumber}${unit ? ` ${unit}` : ""}`
            );
          }
        }
      }
    });
  }

  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = validateDocConstants();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`doc constant: ${problem}`);
    process.exitCode = 1;
  } else {
    const total = contractConstants().size;
    console.log(`doc constants ok: every documented value matches its declaration (${total} constants read from src)`);
  }
}
