# Guardian Ecosystem

Loom recovery is intentionally verifier-based. The account stores only a
guardian Merkle root and threshold; each leaf commits to a verifier address,
that verifier's runtime code hash, a salted key commitment, and a salt. This
keeps guardian types outside the immutable account core while still binding
recovery approval to exact verifier bytecode.

## Supported verifier classes

| Guardian type | Loom support | Commitment | Notes |
|---|---|---|---|
| Address-backed guardian | `ECDSAGuardianVerifier` | `keccak256(abi.encode(guardian))` | Suitable for hardware wallets that expose an Ethereum address, including Ledger-style signer setups. |
| Passkey guardian | `P256GuardianVerifier` | `WebAuthnP256.fingerprint(publicKey)` | Uses the same WebAuthn checks as the primary passkey validator: relying-party hash, origin, user verification, challenge binding, and low-s signatures. |
| Multisig guardian | `ERC1271GuardianVerifier` | `keccak256(abi.encode(signerContract))` | Supports Safe, Loom accounts, and other audited ERC-1271 contract wallets without granting them general account execution authority. |
| Institutional guardian | `ERC1271GuardianVerifier` or a dedicated verifier | Depends on verifier | A provider must expose a reviewable on-chain policy. Loom must not require any specific provider. |
| HSM guardian | `ECDSAGuardianVerifier`, `P256GuardianVerifier`, or `ERC1271GuardianVerifier` | Depends on signer path | The HSM must sign the exact Loom recovery digest through a verifiable on-chain path. |
| zkEmail guardian | Not implemented in production source | Future audited verifier | Requires a concrete circuit, DKIM/root trust model, nullifier policy, replay rules, and independent audit before activation. |

## Security rules

- Guardian verifier contracts are not registries and do not receive upgrade,
  execution, token, or recovery-provider authority.
- A guardian leaf binds `verifier.codehash`; proxy or mutable verifier
  implementations are not acceptable production guardians.
- Acting guardians reveal their verifier, commitment, salt, proof, and
  signature. Successful recovery must rotate to a fresh guardian root.
- Hardware and institutional guardians are integration patterns, not trusted
  Loom services. Users must be able to choose independent providers or remove
  them through the account timelock.
- zkEmail support must not be represented as production-ready until the exact
  circuit, verifier, DKIM trust source, and proof-generation UX are reviewed.

## Industry references

- Safe keeps extension logic in modules and warns that modules can execute
  arbitrary transactions if trusted incorrectly. Loom follows the separation
  pattern but keeps guardian verifiers unable to execute account calls.
- Safe passkey support treats passkeys as a seed-phrase alternative backed by
  device-secured private keys.
- Argent popularized guardian recovery with a visible security period and
  cancellation window.
- ZK Email provides SDK and recovery-demo infrastructure, but Loom requires a
  concrete audited verifier before adding email recovery to production source.
