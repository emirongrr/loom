# Loom Wallet Lab

Wallet Lab is a local, read-only diagnostic surface over Loom's existing pinned
devnet. It records a real SDK -> Alto -> EntryPoint -> Loom account operation as
a typed lifecycle artifact, checks independent invariants, and renders the
timeline and semantic state diff without adding production authority.

The UI presents one operation through five deliberately separate evidence
lenses:

- **Architecture** shows the static deployment topology derived from the pinned
  manifest, compiler artifacts, and repository source metadata.
- **Execution** shows the observed call tree for a specific transaction. It is
  never presented as the architecture graph.
- **Authority** distinguishes actors that approve, reject, constrain, publish,
  delay, execute, or merely observe the operation.
- **Effects & EVM** combines the call/opcode view with independently measured
  semantic before/after values.
- **Privacy** answers who learned which operation data: authenticator, RPC,
  bundler, public chain, and contract target are separate observers.

Every rendered claim carries a normalized provenance category such as
`observed_trace`, `observed_receipt`, `derived_from_manifest`, `inferred`, or
`unavailable`, plus a confidence level and stable references where available.
Missing trace or state-diff capability produces an explicit limitation instead
of invented execution detail.

## Run

Use Node 22 and install repository dependencies as described in the root
README. Then:

```sh
npm run wallet-lab:run
```

Open `http://127.0.0.1:4173`. The command starts the existing Anvil/Loom/Alto
devnet, runs the deterministic passkey native-transfer scenario, writes
`.loom/wallet-lab/latest-run.json`, drives the real passkey wallet example
through Saved Wallet unlock, activation, and a 123 wei transfer, and keeps the
diagnostic UI open. The run also writes `wallet-example.png` and
`browser-trace.zip`. Press Ctrl+C for graceful shutdown. Override only the UI port with
`LOOM_WALLET_LAB_PORT`; devnet process ownership and ports remain governed by
`loom devnet`.

To inspect an existing artifact without running a chain:

```sh
npm run wallet-lab:serve -- .loom/wallet-lab/latest-run.json
```

Use the deployment selector in the UI to inspect either the deterministic local
deployment or the bundled Sepolia profile. Local run artifacts can populate all
five lenses. Sepolia inspection is intentionally read-only: a transaction hash
can be analyzed only to the extent supported by the configured public RPC. The
UI does not combine local trace evidence with Sepolia manifest claims.

To replay from a clean devnet:

```sh
npm run wallet-lab:replay -- .loom/wallet-lab/latest-run.json
```

Replay refuses another schema, scenario version, scenario identifier, or seed.
It writes a sibling `.replay.json` and fails unless the derived account,
UserOperation hash, semantic state diff, and invariant results match; generated
runs are ignored by Git. Phase 1 replays successful runs. Failed-run replay is
deliberately refused until the artifact can declare the exact deterministic
fault that must be reproduced.

## What Phase 1 proves

- Exact Anvil, Alto, EntryPoint, Loom address, and runtime-code-hash identity.
- Deterministic test credential identity from the versioned scenario seed.
- Account derivation, reviewed call intent, gas estimation, WebAuthn-shaped
  assertion fields, packing, independent UserOperation hash, submission,
  inclusion, and explicit local finality.
- Receipt hash/sender/transaction provenance and exact before/after native
  balance, target value, nonce, EntryPoint deposit, and account code hash.
- Atomic, permission-restricted artifact writes and a loopback-only, no-store,
  CSP-protected viewer.
- Real React UI actions, a UV-capable CDP virtual authenticator, browser RPC
  evidence, screenshot, and Playwright trace. Credential provisioning happens
  before tracing so private PKCS#8 test material is excluded.

The test credential is public test material. Never use it on a public chain or
with assets of value. Production keys, passkeys, endpoint credentials, cookies,
mnemonics, and browser storage state must never be provided to Wallet Lab.

## Status language

`simulated` means only that gas simulation accepted the operation.
`success` on submission means Alto returned the independently expected hash.
`included` requires a matching UserOperation receipt and successful enclosing
transaction. `finalized` requires the scenario's later-block policy. These
states are never aliases.

## Trace capability and fallback

Wallet Lab probes provider capabilities before presenting trace-derived facts.
Call frames require a supported transaction tracer. Storage and balance changes
require state-difference evidence or independent before/after reads. A provider
that exposes only receipts can still prove inclusion, logs, gas use, and the
enclosing transaction, but it cannot prove internal call frames or storage
writes. Those panels remain explicitly unavailable rather than silently falling
back to speculation.

## Troubleshooting

- Use Node 22; other Node majors are unsupported.
- Run `npm --prefix packages/privacy ci` before repository verification in a
  clean independent worktree.
- If `npm ci` reports `ENOTEMPTY` on Windows, ensure another install is not
  operating on the same package tree, then retry that package install. Do not
  kill unrelated Node processes by name.
- If devnet startup refuses a port or stale state, use `loom devnet status` and
  `loom devnet down`; the CLI acts only on its recorded PIDs.
- The UI intentionally stays open after a failed scenario so the first failing
  boundary remains inspectable.

## Deliberate limitations

The virtual authenticator proves Chromium WebAuthn protocol behavior, not a
platform authenticator, biometric prompt, mobile browser, or hardware security
property. The local verification URL is a distinct endpoint routed to the same
hermetic Anvil node, so it tests independent-read logic but is not evidence of
independent provider operation. Real-device/browser coverage remains a manual
release matrix. Rundler, reorg injection, recovery, sponsored operations, and
trace-bundle minimization remain later phases.
