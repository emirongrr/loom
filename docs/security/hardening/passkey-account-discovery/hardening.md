# Security Hardening Review: Passkey Account Discovery

## Outcome

Do not replace the current `userHandle` mechanism with credential ID, public-key
commitment, `largeBlob`, PRF, or a backend index. Rename its protocol meaning
from `walletId` to `accountHandle` and make discovery return an explicit status:
`NOT_ACTIVATED`, `ACTIVE`, `STALE`, or `INVALID`.

The current mechanism is the WebAuthn-native answer to “which account does this
credential belong to?” The missing product concept is status, not another ID.

## Portfolio

| Option | Security | Recovery | Reliability | Decision |
| --- | --- | --- | --- | --- |
| Stable `accountHandle` in `userHandle` | Locator remains non-authoritative; constant lookup | Same handle survives key replacement | Uses mandatory discoverable-credential output | Recommend |
| Credential-ID hash | Exact credential identity | Every replacement needs a new binding lifecycle | Stale/revoked mappings and initial claim race | Reject as canonical |
| Public-key commitment | Cryptographically close to authority | Replacement changes it | Clean-device assertion does not return the public key | Reject |
| `largeBlob` account pointer | Per-credential local pointer | Must be rewritten per replacement | Optional and cannot be written in registration | Optional cache only |
| PRF-encrypted pointer | Hides stored pointer | New credential yields a new PRF relation | Optional and still needs a place to find ciphertext | Reject as locator |
| Backend credential index | Simple | Easy rotation | Violates Loom walkaway/provider independence | Reject as canonical |

Full analysis: [proposal](proposals/model-passkey-account-status.md).
