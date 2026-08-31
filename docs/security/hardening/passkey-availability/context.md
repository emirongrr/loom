# Local Context: Passkey Availability And Recovery UX

Source root: repository root.

This analysis records the product decision as of 2026-08-28: onboarding remains a one-click native WebAuthn ceremony; backup guidance moves to Security; authenticator-bound credentials remain valid because guardian recovery is an independent recovery path; a synced discoverable credential uses its v3 locator to find the same account on another device.

Evidence inventory:

- `E001` — WebAuthn backup flags: W3C Web Authentication Level 3, §6.1.3. BE describes backup eligibility and BS describes current backup state; neither flag is wallet authority. <https://www.w3.org/TR/webauthn-3/>
- `E002` — Native registration and assertion: `examples/passkey-wallet-web/src/features/onboarding/accountLifecycle.ts`.
- `E003` — Account discovery and live-key verification: `packages/sdk/src/accountDiscovery.ts` and `examples/passkey-wallet-web/src/app/App.tsx`.
- `E004` — Guardian recovery preparation: `examples/passkey-wallet-web/src/features/recovery/recoveryPasskey.ts`.
- `E005` — Saved account metadata and Security presentation: `examples/passkey-wallet-web/src/types.ts`, `examples/passkey-wallet-web/src/storage/accountStore.ts`, and `examples/passkey-wallet-web/src/features/security/SecurityPage.tsx`.

The evidence inventory was initially collected while implementation source drift was present, as recorded in `hardening.json`. Every source path listed above is present in target-base commit `5e18a2b8e46471c618a747899ced819bd1b1c78a`; final release evidence must still be generated from the clean release revision.
