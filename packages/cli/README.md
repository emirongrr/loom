# @loom/cli

The thin `loom` command line. It orchestrates the Loom libraries and repository
tooling; it never reimplements encoding, hashing, or manifest rules, never
accepts a raw private key as an argument, and supports `--json` on every command
(one JSON object on stdout, diagnostics on stderr).

## `loom devnet`

A reproducible local stack — anvil, the repo-pinned Loom contracts, and the
[Alto](https://github.com/pimlicolabs/alto) bundler. Every version is fixed in
[`devnet/versions.json`](../../devnet/versions.json). Alto is resolved at run
time into a gitignored cache (`.loom/bundler`) rather than committed, so its
large transitive tree stays out of the repository — the first `up` installs the
pinned version and later runs reuse it.

```sh
loom devnet up        # start anvil + deploy Loom + start Alto, health-checked
loom devnet status    # report endpoints, addresses, and live health
loom devnet logs alto # tail a component log (anvil | alto | deploy)
loom devnet down      # stop exactly what `up` started
```

`up` records what it started in `.loom/devnet/state.json`. `down`, `status`, and
`logs` act **only** on the resources that file names — the CLI never kills or
inspects a process it did not start, and `down` refuses to guess when no state
was recorded.

The EntryPoint is CREATE2-deployed at a version-prefixed address (bundlers infer
the EntryPoint version from the address prefix); the salt is pinned to the exact
creation code, and `up` fails closed if the code changes without a re-mined salt.

The bundler executor and utility keys are anvil's well-known deterministic
accounts — public constants, devnet only — and reach Alto through environment
variables, never argv. The CLI accepts no private key.

## `loom doctor`

Read-only production-operation diagnostics. Each check delegates to an existing,
tested primitive — manifest code-hash verification and the P-256 precompile
probe from `@loom/deployment`, account safety-state reads from `@loom/sdk` — and
the doctor only sequences them and normalizes the report. It never signs, sends,
or mutates, and every endpoint is redacted to its origin in all output,
including inside error messages.

```sh
loom doctor --rpc-url <url> [--bundler-url <url>] [--manifest <path>] \
            [--entrypoint <addr>] [--account <addr>] [--chain-id <n>] \
            [--recovery-module <addr>] [--json]
```

Checks: runtime/pinned-tool versions; chain reachability and id; deployment
component code hashes (with `--manifest`) or EntryPoint code presence;
`EntryPoint.senderCreator()` code; native P-256 precompile behaviour; bundler
supported EntryPoints (with `--bundler-url`); and account freeze/pending state
(with `--account` and `--chain-id`). Any verification failure exits `6`.

## `loom deploy` and `loom manifest`

Read-only deployment inspection and verification. Every check delegates to the
tested `@loom/core` (schema parsing, canonical hash) and `@loom/deployment`
(on-chain code-hash verification) primitives — nothing is reimplemented, nothing
signs or mutates, and no network is touched without `--rpc-url`.

```sh
loom manifest validate --manifest ./manifest.json [--rpc-url <url>] [--json]
loom manifest diff --old ./a.json --new ./b.json [--json]
loom deploy inspect --manifest ./manifest.json [--rpc-url <url>] [--json]
loom deploy verify --manifest ./manifest.json --rpc-url <url> [--json]
```

- **`manifest validate`** — schema-checks the manifest and prints its canonical
  hash; with `--rpc-url` it also confirms every component's code hash on chain.
  A schema or on-chain mismatch exits `6`.
- **`manifest diff`** — classifies the differences between two manifests:
  EntryPoint / factory / implementation / validator / recovery changes are
  **breaking**, a chain-id change is **incompatible**, hooks and metadata are
  **notable**. An incompatible or breaking diff exits `6`.
- **`deploy inspect`** — shows the manifest, labelling each contract *verified*
  (chain-confirmed with `--rpc-url`) or *asserted* (manifest-only).
- **`deploy verify`** — fails closed (exit `6`) on any code-hash mismatch.

The signer-driven verbs (`plan` / `apply` / `resume`) are a separate,
larger concern and are not part of this read-only family yet.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | input or configuration error |
| 5 | transport or health failure |
| 6 | verification failure |

## Evidence

`tools/e2e/bundler-devnet.mjs` (`npm run e2e:bundler-devnet`) brings this devnet
up and drives the full `@loom/sdk` send pipeline against the live Alto bundler,
the capstone proof that the wallet engine works with a real bundler.
