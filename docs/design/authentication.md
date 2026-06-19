# Multiple Passkeys And MFA

`MultiP256Validator` lets one Loom account use multiple independent WebAuthn
P-256 credentials with an account-selected threshold.

## Security model

- Every credential has a non-zero identifier and a complete WebAuthn public
  key configuration.
- Credential identifiers and public-key fingerprints are unique per account.
  Registering the same passkey under multiple identifiers cannot satisfy a
  threshold.
- Submitted credential signatures must be sorted by identifier. Duplicate,
  unknown, invalid, or unsorted credentials fail closed.
- At most 16 credentials may be registered or submitted in one validation.
- The threshold is always between one and the current credential count.
- Adding or removing a credential, changing the threshold, and changing the
  policy hook require the account configuration timelock and advance
  `configVersion`.
- Removing a credential cannot reduce the credential count below the current
  threshold.

The validator uses the same `WebAuthnP256` verification library as the
single-credential `P256Validator`, including relying-party, origin, challenge,
user-presence, user-verification, size, and low-s checks.

## Graded access

Threshold MFA does not grant unrestricted account authority. It authorizes
ERC-4337 UserOperations after checking the configured threshold and installed
policy hook. The validator does not call `PolicyHook.isLowRisk` during
`validateUserOp`, because bundler validation must avoid execution-policy reads
that can break ERC-4337 validation rules. Policy enforcement happens when the
account executes the UserOperation.

Direct signed execution remains low-risk only: direct-capable validators call
the installed `PolicyHook` before accepting the direct execution digest.
High-risk execution continues to require the guardian or delayed execution path.

The validator rejects arbitrary ERC-1271 messages. This prevents an MFA
signature over an opaque hash from bypassing transaction policy.

## Operational guidance

Wallet clients should place threshold credentials on independently controlled
devices and clearly distinguish:

- Adding a backup credential.
- Increasing or reducing the required threshold.
- Removing a lost credential.
- Starting guardian recovery.

Multiple credentials on one synchronized platform account may improve
availability without providing meaningful compromise independence.
