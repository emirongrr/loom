# Loom

**Self-sovereign wallet infrastructure**

Loom is building a wallet experience where users should not need to manage
seed phrases, trust a single RPC provider, expose their complete financial
graph, or remain dependent on one company.

The goal is not another wallet-shaped service. Loom is intended to become a
self-sovereign financial operating system built on Ethereum: simple during
normal use, independently verifiable when it matters, and replaceable without
permission.

## Principles

- User ownership over platform ownership.
- Privacy by default.
- Recovery without custodians.
- Verification without trust.
- Interoperability without capture.
- Security without sacrificing usability.

## Vision

A Loom user should be able to:

- create an account with a passkey;
- recover access through independently chosen guardians;
- verify chain state without trusting a hosted RPC;
- maintain separate identities across applications;
- transact without unnecessarily exposing their financial graph;
- move across compatible chains with clearly disclosed trust assumptions;
- switch clients and infrastructure providers without permission;
- walk away from Loom without losing control of their account.

No seed phrases as the default. No mandatory intermediary. No developer
backdoor. No lock-in.

## The walkaway test

If Loom's developers, frontend, bundler, paymaster, RPC, indexer, notification
service, and recovery coordinator disappear, users must still be able to
discover account state, verify it, recover access, and publish authorized
operations using independent software.

Features that cannot pass this test may exist only as optional conveniences
with documented provider-independent alternatives.

## This repository

This repository contains the immutable on-chain account and authorization
layer for that vision. It does not contain the future wallet client, private
transfer system, local chain verifier, or cross-chain routing layer.

The contracts have no privileged Loom administrator, upgrade proxy, arbitrary
delegatecall execution, or mandatory dependency on a specific bundler,
paymaster, recovery provider, RPC, or wallet client.

## Security status

This is pre-audit software. Do not use it to secure production assets.

## Implemented contracts

- Immutable account core with no developer or factory authority.
- ERC-4337 v0.9 validation and atomic single or batch execution.
- Passkey-first authentication with optional threshold credentials.
- Bounded, enumerable, and revocable session permissions.
- Visible delayed recovery with guardian threshold approval and cancellation.
- Explicitly limited ERC-7579 profile that rejects unsupported authority.

## Development

```sh
npm ci
npm run verify:quick
```

Node.js 22 and Foundry v1.7.1 are the supported development baseline.
`npm run verify:quick` runs the fast local quality gates with per-step timing.
`npm run verify` additionally runs the CI fuzz and invariant profile.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/design/architecture.md)
- [Product principles](docs/project/principles.md)
- [Threat model](docs/security/threat-model.md)
- [Security assumptions and residual risks](docs/security/assumptions-and-risks.md)
- [Production readiness gates](docs/security/production-readiness.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Licensed under the MIT License.
