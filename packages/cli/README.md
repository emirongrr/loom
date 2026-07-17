# @loom/cli

The thin `loom` command line. It orchestrates the Loom libraries and repository
tooling; it never reimplements encoding, hashing, or manifest rules, never
accepts a raw private key as an argument, and supports `--json` on every command
(one JSON object on stdout, diagnostics on stderr).

## `loom devnet`

A reproducible local stack — anvil, the repo-pinned Loom contracts, and the
[Alto](https://github.com/pimlicolabs/alto) bundler. Every version is fixed in
[`devnet/versions.json`](../../devnet/versions.json).

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
accounts — public constants, devnet only. The CLI accepts no private key.

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
