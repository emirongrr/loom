# Local Context: Passkey Availability And Recovery UX

Source root: repository root.

This analysis records the product decision made in the working session on 2026-08-28: onboarding remains a one-click native WebAuthn ceremony; backup guidance moves to Security; authenticator-bound credentials remain valid because guardian recovery is an independent recovery path; a synced discoverable credential uses its v3 locator to find the same account on another device.

Evidence inventory:

- `E001` — WebAuthn backup flags: W3C Web Authentication Level 3, §6.1.3. BE describes backup eligibility and BS describes current backup state; neither flag is wallet authority. <https://www.w3.org/TR/webauthn-3/>
- `E002` — Native registration and assertion: `examples/passkey-wallet-web/src/features/onboarding/accountLifecycle.ts`.
- `E003` — Account discovery and live-key verification: `packages/sdk/src/accountDiscovery.ts` and `examples/passkey-wallet-web/src/app/App.tsx`.
- `E004` — Guardian recovery preparation: `examples/passkey-wallet-web/src/features/recovery/recoveryPasskey.ts`.
- `E005` — Saved account metadata and Security presentation: `examples/passkey-wallet-web/src/types.ts`, `examples/passkey-wallet-web/src/storage/accountStore.ts`, and `examples/passkey-wallet-web/src/features/security/SecurityPage.tsx`.

The source tree was already dirty from the account-handle and recovery work described in the conversation. The analysis therefore records source drift as present and does not claim a clean revision.
