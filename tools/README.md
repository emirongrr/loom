# Tooling Layout

Repository tools are grouped by the evidence or maintenance boundary they
serve. Keep new scripts in the narrowest matching directory and expose them
through `package.json` when they are part of the supported workflow.

| Directory | Purpose |
| --- | --- |
| `ci/` | Repository verification orchestration and CI-program validation. |
| `evidence/` | Release evidence builders, validators, and rehearsal checkers. |
| `formal/` | Local wrappers and program validators for Halmos, Certora, Kontrol, and Lean. |
| `keystore/` | Keystore proof fixture generation helpers. |
| `quality/` | Dependency, coverage, documentation, and source-policy checks. |
| `sdk/` | SDK fixture generation and type-consumer checks. |
| `site/` | Documentation site build and validation helpers. |

Do not commit local configs, private endpoints, generated secrets, or fake
release evidence. Evidence tools should either validate committed public
artifacts or build release candidates from externally collected facts and then
fail closed through a validator before writing output.
