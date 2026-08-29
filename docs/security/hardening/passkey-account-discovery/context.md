# Evidence Context: Passkey Account Discovery

Assessment date: 2026-08-27. Target revision:
`cf09f60cdce2009604acad24ca28e30f7cda699b`. Source drift is present; this is
an architecture decision over the current working snapshot, not release proof.

| ID | Evidence | SHA-256 / reference |
| --- | --- | --- |
| E01 | `src/AppAccountRegistry.sol` | `0856cc42a904b67839706e78716f20275b60eab648222033006ad8d56d31ae97` |
| E02 | `src/LoomAccountFactory.sol` | `7484b4af5649005a31aeac8782099b04024841fc9fd90be65f7861b861182adf` |
| E03 | `src/validators/P256Validator.sol` | `2597df667211ae402f5be58902b848fe2605e6008c9788fb13ae48cac5c691f9` |
| E04 | `examples/passkey-wallet-web/src/features/onboarding/passkeyUserHandle.ts` | `e020dd5ad8fc60b5b03f664d7c9a689f9788c77792f30724f500f2e7e00d0e33` |
| E05 | `examples/passkey-wallet-web/src/features/wallet/webauthn.ts` | `338eb07f16caa8aab8acf15e8cb951352204b329eee841340ae9a0b6cb51c2de` |
| E06 | `examples/passkey-wallet-web/src/app/App.tsx` | `4ec9d4fc53b0773da77aa21c749a600e392483c3e7780e1e4a336997ac3af13a` |
| E07 | `examples/passkey-wallet-web/src/features/recovery/RecoveryPage.tsx` | `aaf92cf2424c1741cd81068651c0bceb3ecc28cc5e569c325a72783be846d8b8` |
| E08 | `docs/decisions/0027-an-account-is-findable-from-the-key-that-opens-it.md` | `af026170b2dfc3476dc7f50ba24822da0409dbddefa21e915af6a770e58b0047` |
| E09 | W3C WebAuthn Level 3, User Handle | <https://www.w3.org/TR/webauthn-3/#user-handle> |
| E10 | W3C WebAuthn Level 3, Large Blob | <https://www.w3.org/TR/webauthn-3/#sctn-large-blob-extension> |

Observed: current discovery resolves one random RP-scoped identifier, then
verifies the fresh assertion against the located account's live validator.
Observed: recovery deliberately reuses the same identifier with a new passkey.
Observed: WebAuthn defines `userHandle` as the account identifier and says it
ought to be shared by credentials for that account; credential IDs are unique
per credential. Inferred: the mechanism is standards-aligned, while the name
`walletId` hides its actual role and encourages credential/account confusion.
