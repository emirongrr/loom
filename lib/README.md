# Vendored Dependencies

Only source files required to build and test Loom are vendored here. Upstream
project tooling, documentation, workflows, and test suites are intentionally
excluded.

| Dependency | Version | Upstream | Purpose |
|---|---:|---|---|
| ERC-4337 Account Abstraction | 0.9.0 | https://github.com/eth-infinitism/account-abstraction | EntryPoint interfaces and integration tests |
| OpenZeppelin Contracts | 5.1.0 | https://github.com/OpenZeppelin/openzeppelin-contracts | EntryPoint transitive imports |
| forge-std | vendored with OpenZeppelin Contracts 5.1.0 | https://github.com/foundry-rs/forge-std | Foundry test utilities |
| Halmos cheatcodes | vendored with OpenZeppelin Contracts 5.1.0 | https://github.com/a16z/halmos | Symbolic test utilities |

Each dependency retains its upstream license. Dependency versions and source
reachability must be reviewed before every release.
