# Live Lifecycle Rehearsal

Live rehearsal evidence is required before Loom can claim migration or vault
readiness on a public network. Local Foundry tests are necessary, but they do
not prove wallet behavior with real token contracts, public mempools, real
receipts, or independent publishers.

`tools/validate-live-rehearsal.mjs` validates a checked evidence file. It does
not broadcast transactions. It intentionally fails unless a real rehearsal
manifest includes transaction hashes, real token addresses, non-standard token
behavior, guardian cancellation, expiry, alternative EntryPoint destination,
native exit fallback, and an explicit statement that no Loom-operated service
was required.

## Required Evidence

The manifest must include:

- network name, chain ID, and non-Loom RPC kind;
- source and destination account addresses;
- EntryPoint and alternative EntryPoint destination address;
- source and destination code hashes;
- at least two real token contracts;
- at least one non-standard, fee-on-transfer, or rebasing token behavior;
- transaction hashes for deployment, funding, migration schedule,
  guardian cancellation, expiry attempt, successful migration, vault schedule,
  vault guardian cancellation, and vault execution;
- boolean checks proving native exit and no Loom service dependency.

## Command

```sh
node tools/validate-live-rehearsal.mjs evidence/live-rehearsal/<network>.json
```

The evidence directory is intentionally not pre-populated with fake data.
Release candidates must add real evidence in a dedicated `test:` pull request.

## Non-Goals

- No private keys in the repository.
- No default RPC, bundler, paymaster, relayer, or recovery coordinator.
- No mock token evidence.
- No production claim from local-only tests.
