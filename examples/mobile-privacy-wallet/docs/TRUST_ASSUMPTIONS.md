# Trust Assumptions

What this example asks the user to trust, and what it deliberately does not.

## Not trusted (by design)

- **No Loom-operated backend.** There is no hosted service in the control or
  recovery path. If Loom disappears, the account remains controllable.
- **No default RPC / bundler / indexer / relayer.** Every endpoint is
  user-supplied and replaceable. A missing endpoint disables the flow instead of
  falling back to a hosted provider.
- **Raw RPC responses.** Plain RPC is treated as an `unverified` transport, never
  as a source of truth for balances, nonces, recovery, guardian, or vault state.
- **Device vendor attestation.** Registration uses `attestation: "none"`; account
  security does not depend on device-vendor fingerprinting.

## Trusted (must be verified before production)

- **The platform credential manager and secure hardware** hold the passkey
  private key. Trust in iOS Keychain / Android Keystore is a device assumption.
- **The committed deployment manifest** names the contract addresses and code
  hashes the app will use. The user trusts that this file was produced from a
  reproducible deployment; the app refuses addresses that do not match it, and a
  production build must confirm the code hashes on chain.
- **The configured chain** provides a permissionless publication and exit path.
- **The Helios checkpoint** is the explicit weak-subjectivity trust root for
  verified reads; the user or integrator chooses it.
- **The bundler** can observe every UserOperation. It is a liveness and metadata
  chokepoint until multi-bundler support and shielded transfers land.

## Client replaceability

Account authority, recovery configuration, validator state, and deployment
metadata live on chain and in the committed manifest — not inside this app. Any
compatible client (another mobile app, a web client, a CLI, or a recovery-only
client) can control the same Loom account. This example is one client, not the
account.
