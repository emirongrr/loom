# Engineering Practices

Loom's engineering method emphasizes observation, measurement, frequent
iteration, simplicity, dogfooding, and process appropriate to the project's
maturity. Process exists to shorten feedback and expose risk, not to create
the appearance of certainty.

The repository is past the unconstrained prototype phase: the account core
works, and failures now have a meaningful security cost. Production paths
therefore require small changes, review, tests, and measured evidence.
Uncertain research may still move quickly, but it must remain clearly isolated
from production claims and immutable authority.

## Working principles

| Principle | Loom practice | Evidence |
|---|---|---|
| Observe and measure | Define a before/after metric for each security or performance change | coverage, gas snapshot, bytecode size, fuzz/invariant counts |
| Iterate frequently | Land vertical behavior slices with their tests and docs | account, session, recovery, and EntryPoint lifecycle tests |
| Speak openly | Keep limitations and release blockers visible | `docs/security/assumptions-and-risks.md`, `docs/security/production-readiness.md` |
| Keep it simple | Immutable core, narrow modules, rejected unsupported modes | `docs/design/architecture.md`, `docs/design/execution.md` |
| Dogfood | One-command local core verification; CI adds coverage, static analysis, and formal checks | `npm run verify:quick`, `npm run verify`, `.github/workflows` |
| Generalize last | Add profiles and adapters only after a concrete repeated need | limited ERC-7579 profile and bounded validators |
| Add process when mature | Use release gates and dependency-ordered slices now that the prototype works | `release-plan.md` |

## Feedback Loops

- Begin with observation: reproduce the behavior and choose a metric or
  security property before changing code.
- Prefer the smallest end-to-end vertical slice that can be executed and
  evaluated over a large horizontal foundation.
- Merge frequently, but never use speed to bypass review or evidence for an
  authority change.
- Use small proofs of concept to reduce uncertainty. Keep them outside the
  production authority path until their assumptions and failure modes are
  understood.
- Keep pipelines readable and debuggable. A failed check must explain what
  evidence is missing.
- Dogfood independent build, deployment, recovery, direct execution, and
  walkaway procedures.

## Toolchain pinning

Everything that can change the bytecode or run code in CI is pinned to an
immutable reference, and `npm run toolchain:check` fails the build when one of
these drifts:

- **One Solidity version.** `foundry.toml`, the `solc` npm dependency,
  `solc-select` invocations, and the Kontrol `SOLC_BINARY` must all name the
  same version. A second compiler reachable from the repository produces
  different bytecode than the gates and the deployment manifest measure, which
  voids the reproducibility claim made about them without failing anything.
- **Every GitHub Action at a commit SHA**, with the human-readable tag kept as a
  trailing comment. A moving tag lets a compromised or merely retagged upstream
  run new code in a job that has repository checkout access.
- **No remote script piped into a shell, and no fetch from a branch ref.**
  Download to a file at a pinned commit, verify a recorded `sha256`, then run
  it. When bumping such a dependency, update the commit and the checksum
  together — the checker only proves the ref is pinned, not that the two agree.

The checker's own tests build broken fixtures and assert each rule fires, so it
cannot pass by checking nothing.

## Dependency audit coverage

The repository is a hybrid monorepo. Four packages are npm workspaces sharing
the root lockfile; every other tree — the remaining SDKs, the CLI, the examples,
the monitoring component, and the documentation site — keeps its own. That is a
deliberate boundary: the examples and the mobile wallet carry build stacks that
have no business in the root dependency tree, and the SDKs are installed
independently by design.

The cost is that `npm audit` sees one lockfile at a time, so coverage is exactly
the target list in `tools/quality/audit-dependencies.mjs`.
`npm run deps:coverage:check` makes that list total: one audit target per
committed lockfile, in both directions. A new tree with a lockfile fails until it
is audited, and a target for a tree that no longer has one fails as a stale claim
of coverage.

The rule takes no judgement and admits no prose exception, because the previous
arrangement was a hand-maintained list with a comment explaining which trees were
covered, and it had fallen behind without anything noticing.

## Documented limits match the contracts

Security documents state contract limits as numbers — `MAX_HOOKS` is 8,
`MIN_CONFIG_DELAY` is 3 days, `MAX_REVERT_DATA_LENGTH` is 2,048 bytes. A reader
budgets against those numbers, so a stale one is worse than none at all.
`npm run docs:constants:check` reads every named numeric constant out of `src/`
and every place the docs state a value for one, and fails when they disagree.
Durations are compared in seconds, so writing 72 hours where the contract says
3 days is accepted.

Two rules follow from what the checker can and cannot see:

- **Name the constant when stating its value.** The checker matches
  `` `NAME` is 8 `` and `` `NAME` (3 days) ``. A number written without the
  constant beside it — "the window is two days" — is invisible to it and will
  rot silently. Prefer naming the constant with no number at all when the exact
  value does not matter to the sentence, as `docs/design/lifecycle.md` does for
  `FREEZE_DURATION`.
- **The checker verifies agreement, not correctness.** It cannot tell whether a
  documented limit is the *right* one to describe in that paragraph, and it
  ignores names the contracts do not declare. It also declines to guess when a
  constant is declared twice with different values, reporting the ambiguity
  instead.

## Storage layout is append-only

`src/LoomAccount.sol` calls its storage block append-only and its order
consensus-critical. Nothing enforced that until `npm run storage:check`, and a
reordered slot is the rare change that passes everything else: the ABI does not
move, so the ABI check is quiet; behaviour does not change, so the tests pass;
the gas difference sits inside the snapshot's tolerance. It surfaces when a
deployed account reads the wrong slot.

`storage-layout.json` pins the label, slot, offset, and type of every variable in
the explicitly listed contracts whose layout something outside their own source
depends on. It matters most where storage outlives a deployment: an EIP-7702
account keeps its storage and re-points at a new implementation, and every module
here is an immutable singleton holding per-account state. The contract list is
deliberate and reviewable; a new stateful contract is not covered until it is
added to that list.

- **Appending is allowed; moving is not.** A variable added after the last one
  cannot disturb a slot already written. Moving, removing, resizing, or
  repacking is reported with the variable and the field that changed, including
  the packing consequences a reader is least likely to catch by eye.
- **The snapshot records the layout, not its correctness.** It proves today's
  layout matches the recorded one. Whether a slot ought to hold what it holds is
  a review question, and re-recording is the last step of a migration rather than
  the fix for a failing check.

## The wire surface is recorded, not just regenerated

`npm run abi:check` proves the committed ABI matches the build. That is
freshness, not compatibility: regenerating produces the diff, and whether anyone
reads what moved is left to review.

`protocol-surface.json` records what a consumer actually binds to for the
explicitly listed contracts: function selectors, return types and mutability;
event topics, anonymous flags and indexed-parameter layout; error selectors;
and EIP-712 schemas and hashes. The case that motivated it is one an ABI diff
cannot show at all: an EIP-712 type string is a `keccak256` constant, so
reordering two fields inside it changes every digest an installed validator will
accept while the ABI stays byte-identical and the tests pass. Like the storage
gate, its contract list is explicit; a new public contract is outside the claim
until the list is updated.

- **Schemas are recorded as the string being hashed.** Comparing two 32-byte
  hashes tells a reviewer nothing. Comparing two type strings shows the field
  that moved, which is the reason the record exists at all.
- **Every addition inside the declared surface must be recorded.** An unrecorded
  function, event, error, listed contract, or typed-data constant fails the gate,
  because an item that was never pinned could later disappear invisibly. As part
  of the reviewed change, `npm run surface:write` records the complete current
  surface. Removing or changing a recorded item is wire-breaking and requires an
  explicit compatibility decision and migration.
- **It sees declared constants, not assembled ones.** A schema built at runtime
  rather than declared as a literal would be invisible to it. Nothing does that
  today; if something starts to, the gate has to learn about it rather than
  quietly covering less.

## A change says what kind of change it is

The two snapshots above answer most of the compatibility question mechanically
by comparing their base and head contents. Appended storage and newly recorded
surface can be compatible; moving an existing slot or changing a recorded wire
value is not. Those semantic differences are facts, so the diff sets a floor and
the pull request description must meet it.

A new Solidity file sets an `additive` floor. Modifying or removing existing
Solidity sets `behavior-changing`; a breaking wire comparison sets
`wire-breaking`; and a breaking storage comparison sets `state-incompatible`.
Missing, renamed, or unreadable snapshot evidence fails closed.

The class no artifact can see is the one the rule exists for — contracts changed
while both snapshots held. That is the behaviour-changing but wire-compatible
case: new revert conditions, different authority, altered lifecycle. It is also
the class most easily described as a refactor, by an author who believes it.

- **Exactly one class, and only where a reader can see it.** The template lists
  the five with what each means, inside an HTML comment; a declaration left in
  that comment does not count, because the checker reads the description as a
  reader sees it rather than as raw text. Two classes are refused rather than
  resolved to the stronger one — a description that hedges is not a declaration.
- **Declaring more than the diff shows is allowed.** Overstating impact costs a
  release note; understating it costs a migration nobody wrote.
- **Adding is not moving.** A newly added snapshot changes no deployed state, and
  a modified snapshot is compared semantically rather than judged by its path
  alone. Compatible additions do not raise the floor to breaking; removal,
  rename, unreadable evidence, or movement of an existing item does.
- **It forces the choice to be stated, not to be correct.** No checker can tell a
  genuine behaviour change from a genuine refactor. That residue is deliberate;
  it is the part that needs a person, and the declaration is where review starts.

## Complexity Budget

Complexity is a security cost. A new abstraction must remove demonstrated
repeated complexity or establish a required interoperability boundary.

Repeating a small explicit pattern can be safer than introducing a general
mechanism with broader authority. Optimize only after measuring a real
requirement, and measure again after the change.

## Process By Uncertainty

Use experiments when the problem is not understood. Use milestones, dependency
ordering, release gates, and thorough review when the behavior and target are
understood. A new research problem may temporarily return to experimentation,
but experimental assumptions must not silently enter production contracts.

## Product quality scorecard

Every release candidate records:

- all normal and CI-profile tests passing;
- symbolic property count and result;
- production source line and branch coverage;
- `LoomAccount` runtime bytecode size;
- gas snapshot changes with explanations;
- static-analysis high-severity result;
- dependency vulnerability result;
- browser/device and live-bundler matrix completion;
- unresolved release blockers.

Metrics are signals, not targets to game. A test or abstraction that raises a
number without reducing uncertainty is not progress.

## Decision threshold

A decision record is required when a change affects authority, immutability,
privacy, recovery, EntryPoint trust, external-service dependency, cryptographic
verification, or a published compatibility claim. The record must state the
problem, measured evidence, considered options, decision, and residual risks.
Use the deliberately small template in `docs/decisions/README.md`.
