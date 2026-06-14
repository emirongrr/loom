# EntryPoint Liveness

## Industry finding

Current major smart accounts generally do not make the trusted EntryPoint an
ordinary mutable account setting:

- Kernel stores one immutable EntryPoint in its implementation constructor.
- Coinbase Smart Wallet returns a fixed EntryPoint address.
- Safe's ERC-4337 module is limited to the EntryPoint selected in its
  constructor.
- Some systems rely on account implementation upgrades to move to a new
  EntryPoint. Loom rejects that developer/admin upgrade tradeoff.

Coinbase Smart Wallet also permits direct calls from an address owner. That
provides a useful liveness fallback for address owners, but it does not by
itself give a passkey-only owner a permissionless transaction publisher and
its upgradeable proxy tradeoff is outside Loom's immutable V1 model.

ERC-4337 requires an account to validate that `validateUserOp` was called by a
trusted EntryPoint, and the signed UserOperation hash binds the EntryPoint.
An EntryPoint deployment is immutable contract code, but it is not an
Ethereum consensus primitive and it is not the only EntryPoint version that
can exist. Bundlers whitelist supported EntryPoints, and an account that
accepts only one deployment cannot start trusting another unless it already
has an independently authorized path to do so.

Bundler censorship is not a permanent authority boundary: ERC-4337 intends any
bundler to participate, and any transaction publisher can call `handleOps`
directly. It remains a practical availability and privacy risk when clients
depend on a small hosted bundler set, and block producers can censor the
resulting transaction like any other transaction.

## Loom decision

Loom V1 retains one immutable EntryPoint. Adding an EntryPoint registry,
developer switch, guardian switch, or immediate mutable allowlist would create
a new censorship or takeover surface.

The sovereign liveness path is a separately audited immutable account version
with:

1. provider-independent direct signed execution that is present from account
   creation, has a domain-separated nonce independent from EntryPoint nonces,
   uses installed validators, and invokes the same hooks;
2. a delayed exact migration intent committing the destination account,
   destination code hash, destination configuration hash, asset calls, nonce,
   chain ID, and expiry;
3. permissionless execution after the delay and cancellation by current
   authority or recovery;
4. no mutable EntryPoint allowlist, Loom-operated registry, upgrade key,
   privileged migrator, or mandatory relayer.

Adding this path to V1 without dedicated review would create a second
authorization system and could undermine every EntryPoint and nonce
assumption. It is therefore a release-blocking V2 design, not a rushed mutable
switch.

Until that design is implemented and audited, EntryPoint failure remains an
explicit V1 liveness risk. Deployment manifests must verify official EntryPoint
bytecode and clients must support independent bundlers and direct
`handleOps` submission.

## References

- https://eips.ethereum.org/EIPS/eip-4337
- https://vitalik.eth.limo/general/2024/12/03/wallets.html
- https://github.com/zerodevapp/kernel
- https://github.com/coinbase/smart-wallet
- https://github.com/safe-fndn/safe-modules
