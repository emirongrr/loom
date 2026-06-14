# Loom Contracts

Loom is an immutable, passkey-first ERC-4337 smart account designed around
graded access, constrained session permissions, guardian recovery, and account
portability. Loom is a tool for users, not a service users must continue
trusting.

The repository contains contracts only. It has no privileged Loom admin, no
upgrade proxy, no arbitrary delegatecall execution, and no dependency on a
specific bundler, paymaster, recovery provider, or wallet client.

## Security status

This is pre-audit software. Do not use it to secure production assets.

## Design properties

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
