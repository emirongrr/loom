// A pull request that changes the protocol must say what kind of change it is,
// and the claim is checked against the diff rather than believed.
//
// The two snapshots in this repository already answer most of the question
// mechanically: their base-to-head semantic comparison distinguishes compatible
// additions from a moved storage slot or changed wire value. Those breaking
// differences are facts, not opinions, so the author cannot classify below them.
//
// What the author still owns is the case no artifact can see: contracts changed
// while both snapshots held. That is the "behaviour-changing but wire-compatible"
// class -- new revert conditions, different authorization, altered lifecycle --
// and it is the class most likely to be described as a refactor. The gate cannot
// prove which it is, so it requires the author to choose and be read.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Ordered weakest to strongest; a declaration may exceed the observation. */
export const CHANGE_CLASSES = Object.freeze([
  "implementation-only",
  "additive",
  "behavior-changing",
  "wire-breaking",
  "state-incompatible"
]);

const rank = value => CHANGE_CLASSES.indexOf(value);
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function storageSnapshotHasBreakingChanges(before, after) {
  if (before?.version !== after?.version) return true;
  for (const [contract, entries] of Object.entries(before?.contracts ?? {})) {
    const current = after?.contracts?.[contract];
    if (!current) return true;
    for (const [index, pinned] of entries.entries()) {
      if (!sameValue(current[index], pinned)) return true;
    }
  }
  return false;
}

export function protocolSnapshotHasBreakingChanges(before, after) {
  if (before?.version !== after?.version) return true;
  for (const [contract, kinds] of Object.entries(before?.contracts ?? {})) {
    const current = after?.contracts?.[contract];
    if (!current) return true;
    for (const [kind, entries] of Object.entries(kinds)) {
      for (const [signature, value] of Object.entries(entries)) {
        if (!sameValue(current[kind]?.[signature], value)) return true;
      }
    }
  }
  for (const [file, entries] of Object.entries(before?.typedData ?? {})) {
    for (const [name, value] of Object.entries(entries)) {
      if (!sameValue(after?.typedData?.[file]?.[name], value)) return true;
    }
  }
  return false;
}

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
export function observedClass(changes, snapshotImpact = {}) {
  const moved = path => {
    const change = changes.find(entry => entry.path === path || entry.previousPath === path);
    if (!change) return false;
    if (change.previousPath === path || change.status === "removed") return true;
    if (change.status === "added") return false;
    // A changed snapshot without a successful semantic comparison fails closed.
    return snapshotImpact[path] ?? true;
  };
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

/** NUL-delimited `git diff --name-status -z` output. */
export function parseNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(code)) throw new Error(`unsupported git name-status code: ${code}`);
    const status = code[0] === "A" ? "added" : code[0] === "D" ? "removed" : "modified";
    if (code[0] === "R" || code[0] === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath === undefined || path === undefined) throw new Error(`incomplete git ${code} record`);
      changes.push({ path, previousPath, status });
    } else {
      const path = fields[index++];
      if (path === undefined) throw new Error(`incomplete git ${code} record`);
      changes.push({ path, status });
    }
  }
  return changes;
}

/** Classes named in a `Change class:` line, in any order or case. */
export function declaredClasses(body) {
  const visibleBody = visibleMarkdown(body ?? "");
  const lines = [...visibleBody.matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?change[ \t]*class[ \t]*:[ \t]*([^\r\n]*)$/gim)];
  // Tokenised rather than matched with word boundaries: the class names contain
  // hyphens, and a boundary assertion around them is both harder to read and
  // easy to get wrong.
  const tokens = lines.flatMap(line => line[1].toLowerCase().split(/[^a-z-]+/).filter(Boolean));
  return CHANGE_CLASSES.filter(value => tokens.includes(value));
}

/**
 * Preserve visible text and line boundaries while blanking HTML comments.
 * A depth counter deliberately treats nested or malformed openers as hidden
 * until every opener closes, so crafted delimiters cannot splice a declaration
 * together or make an outer comment end early.
 */
export function visibleMarkdown(body) {
  let visible = "";
  let depth = 0;
  for (let index = 0; index < body.length; ) {
    if (body.startsWith("<!--", index)) {
      depth += 1;
      visible += "    ";
      index += 4;
    } else if (depth > 0 && body.startsWith("-->", index)) {
      depth -= 1;
      visible += "   ";
      index += 3;
    } else {
      const character = body[index++];
      visible += depth === 0 || character === "\r" || character === "\n" ? character : " ";
    }
  }
  return visible;
}

/** Why the diff says what it says, so the message argues rather than asserts. */
const EVIDENCE = Object.freeze({
  "state-incompatible": "storage-layout.json moved: deployed accounts would read different slots.",
  "wire-breaking": "protocol-surface.json moved: a selector, topic, error, or typed-data schema changed.",
  "behavior-changing": "Solidity under src/ was modified, so behaviour may differ even with both snapshots intact.",
  additive: "A new contract was added under src/."
});

export function validate(changes, body, snapshotImpact = {}) {
  const observed = observedClass(changes, snapshotImpact);
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

  if (declared.length !== 1) {
    return [`Declare exactly one change class; found: ${declared.join(", ")}.`];
  }

  const strongest = declared.reduce((left, right) => (rank(right) > rank(left) ? right : left));
  if (rank(strongest) < rank(observed)) {
    return [
      `Declared "${strongest}", but the diff shows "${observed}".`,
      EVIDENCE[observed],
      ``,
      `Declare at least "${observed}". If the movement is intentional, document`,
      `the compatibility consequence and migration in the pull request.`
    ];
  }

  return [];
}

function changesFrom(base, run = spawnSync) {
  const result = run("git", ["diff", "--name-status", "-z", `${base}...HEAD`, "--"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(`git diff failed: ${result.stderr}`);
  return parseNameStatus(result.stdout);
}

function jsonAtRevision(revision, path, run = spawnSync) {
  const result = run("git", ["show", `${revision}:${path}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git show failed for ${path}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function snapshotImpactFrom(base, changes, run = spawnSync) {
  const impact = {};
  const modified = path => changes.some(change => change.path === path && change.status === "modified");
  if (modified("storage-layout.json")) {
    impact["storage-layout.json"] = storageSnapshotHasBreakingChanges(
      jsonAtRevision(base, "storage-layout.json", run),
      JSON.parse(readFileSync(join(root, "storage-layout.json"), "utf8"))
    );
  }
  if (modified("protocol-surface.json")) {
    impact["protocol-surface.json"] = protocolSnapshotHasBreakingChanges(
      jsonAtRevision(base, "protocol-surface.json", run),
      JSON.parse(readFileSync(join(root, "protocol-surface.json"), "utf8"))
    );
  }
  return impact;
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
  const snapshotImpact = changedFile ? {} : snapshotImpactFrom(argument("base") ?? "origin/main", changed);

  const problems = validate(changed, body, snapshotImpact);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`change class ok: diff observed as "${observedClass(changed, snapshotImpact)}"`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main();
}
