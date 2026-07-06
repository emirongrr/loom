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
itself give a passkey-only owner a permissionless transaction publisher.

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

Loom stores one EntryPoint per account during construction or initialization.
Adding an EntryPoint registry,
developer switch, guardian switch, or immediate mutable allowlist would create
a new censorship or takeover surface.

The account includes a sovereign liveness path with:

1. provider-independent direct signed execution present from account creation,
   with validator-scoped domain-separated nonces independent from EntryPoint
   nonces, explicit direct-capable validators, current policy checks, and the
   same hooks;
2. a delayed exact migration intent committing the destination account,
   destination code hash, optional destination configuration hash, asset calls,
   nonce, chain ID, and expiry;
3. permissionless execution after the delay and cancellation by current
   authority or guardian threshold;
4. no mutable EntryPoint allowlist, Loom-operated registry, upgrade key,
   privileged migrator, or mandatory relayer.

Direct signed execution removes the EntryPoint as a permanent publication
dependency. Sovereign migration lets the user move assets or authority to a new
Loom account with a different EntryPoint or to a future account standard whose
runtime code hash is explicitly committed. Deployment manifests must still
verify official EntryPoint bytecode, and clients must support independent
bundlers, direct `handleOps`, and direct signed account execution.

Direct execution preserves graded access: a primary or MFA validator may
publish low-risk calls immediately, while arbitrary high-risk calls must first
schedule the exact operation and wait for the account timelock. EntryPoint loss
therefore does not remove safety delays.

## References

- https://eips.ethereum.org/EIPS/eip-4337
- https://github.com/zerodevapp/kernel
- https://github.com/coinbase/smart-wallet
- https://github.com/safe-fndn/safe-modules
