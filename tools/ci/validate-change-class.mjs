// A pull request that changes the protocol must say what kind of change it is,
// and the claim is checked against the diff rather than believed.
//
// The two snapshots in this repository already answer most of the question
// mechanically: if `storage-layout.json` moved, deployed accounts read different
// slots; if `protocol-surface.json` moved, a selector, topic, error, or
// typed-data schema that consumers encode against changed. Both are facts, not
// opinions, so the author cannot classify below them.
//
// What the author still owns is the case no artifact can see: contracts changed
// while both snapshots held. That is the "behaviour-changing but wire-compatible"
// class -- new revert conditions, different authorization, altered lifecycle --
// and it is the class most likely to be described as a refactor. The gate cannot
// prove which it is, so it requires the author to choose and be read.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Ordered weakest to strongest; a declaration may exceed the observation. */
export const CHANGE_CLASSES = Object.freeze([
  "implementation-only",
  "additive",
  "behavior-changing",
  "wire-breaking",
  "state-incompatible"
]);

const rank = value => CHANGE_CLASSES.indexOf(value);

/**
 * The strongest class the diff itself demonstrates.
 *
 * Addition and modification are read differently, because they are different
 * claims. A snapshot that *moved* says a slot or a selector shifted underneath
 * consumers. A snapshot that was *added* says something is now recorded that was
 * not recorded before, which changes nothing that is deployed. Conflating the
 * two makes the change that introduces a gate look like the worst change the
 * gate can describe -- and pass only by overstating itself.
 *
 * The same distinction applies to contracts: a new `.sol` file adds surface, so
 * it is additive. Anything that wires it into an existing contract modifies that
 * contract, which is caught on its own.
 */
export function observedClass(changes) {
  const moved = path => changes.some(change => change.path === path && change.status !== "added");
  const touchedSolidity = status =>
    changes.some(
      change => change.path.startsWith("src/") && change.path.endsWith(".sol") && change.status === status
    );

  if (moved("storage-layout.json")) return "state-incompatible";
  if (moved("protocol-surface.json")) return "wire-breaking";
  if (touchedSolidity("modified") || touchedSolidity("removed")) return "behavior-changing";
  if (touchedSolidity("added")) return "additive";
  return "implementation-only";
}

/** `git diff --name-status` output, with renames read as modifications. */
export function parseNameStatus(output) {
  return output
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const fields = line.split("\t");
      const code = fields[0][0];
      // A rename keeps the destination path; the content still moved.
      const path = fields[fields.length - 1];
      const status = code === "A" ? "added" : code === "D" ? "removed" : "modified";
      return { path, status };
    });
}

/** Classes named in a `Change class:` line, in any order or case. */
export function declaredClasses(body) {
  const line = /change\s*class\s*:\s*(.+)/i.exec(body ?? "");
  if (!line) return [];
  // Tokenised rather than matched with word boundaries: the class names contain
  // hyphens, and a boundary assertion around them is both harder to read and
  // easy to get wrong.
  const tokens = line[1].toLowerCase().split(/[^a-z-]+/).filter(Boolean);
  return CHANGE_CLASSES.filter(value => tokens.includes(value));
}

/** Why the diff says what it says, so the message argues rather than asserts. */
const EVIDENCE = Object.freeze({
  "state-incompatible": "storage-layout.json moved: deployed accounts would read different slots.",
  "wire-breaking": "protocol-surface.json moved: a selector, topic, error, or typed-data schema changed.",
  "behavior-changing": "Solidity under src/ was modified, so behaviour may differ even with both snapshots intact.",
  additive: "A new contract was added under src/."
});

export function validate(changes, body) {
  const observed = observedClass(changes);
  if (observed === "implementation-only") return [];

  const declared = declaredClasses(body);
  if (declared.length === 0) {
    return [
      `This pull request changes the protocol, so it must declare its impact.`,
      `Add a line to the description:  Change class: ${observed}`,
      ``,
      `Allowed values, weakest to strongest: ${CHANGE_CLASSES.join(", ")}.`
    ];
  }

  const strongest = declared.reduce((left, right) => (rank(right) > rank(left) ? right : left));
  if (rank(strongest) < rank(observed)) {
    return [
      `Declared "${strongest}", but the diff shows "${observed}".`,
      EVIDENCE[observed],
      ``,
      `Declare at least "${observed}", or explain in the description why the`,
      `snapshot moved without the compatibility consequence it normally implies.`
    ];
  }

  return [];
}

function changesFrom(base, run = spawnSync) {
  const result = run("git", ["diff", "--name-status", `${base}...HEAD`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git diff failed: ${result.stderr}`);
  return parseNameStatus(result.stdout);
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const bodyFile = argument("body-file");
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : (process.env.PR_BODY ?? "");
  const changedFile = argument("changed-file");
  const changed = changedFile
    ? parseNameStatus(readFileSync(changedFile, "utf8"))
    : changesFrom(argument("base") ?? "origin/main");

  const problems = validate(changed, body);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`change class ok: diff observed as "${observedClass(changed)}"`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main();
}
