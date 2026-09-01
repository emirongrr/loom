# Security Hardening Review: Passkey Availability And Recovery UX

## Evidence Basis

This review covers the WebAuthn ceremony, v3 discovery, account store, guardian recovery, and Security UI. The source evidence is inventoried in [context.md](context.md). The central distinction is that WebAuthn backup flags describe credential availability, while the live validator key describes authority.

## Constraints

Onboarding must remain a one-click native passkey ceremony. Loom must not claim it can export private credential material, choose a provider on the user's behalf, or infer that `BE=0` means a credential is physically confined to one computer. Locator data may identify an account candidate but can never authorize it.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Separate passkey availability guidance from wallet authority | WebAuthn flags, v3 live-key discovery, and guardian recovery (`E001`–`E005`) | Block non-backed-up credentials; risk-adaptive post-onboarding guidance | Use risk-adaptive guidance while preserving assertion and live-validator gates | [Model passkey availability without blocking onboarding](proposals/model-passkey-availability.md) |

## Recommendation Summary

The risk-adaptive design is recommended under the current product constraint. It keeps creation fast, treats guardian recovery as an independent protection, records only verified BE/BS observations, and makes provider choices visible without implying that the RP controls the native passkey store.

## Next Decisions

Run a real second-device rehearsal for Google/Apple sync and a roaming-key rehearsal for YubiKey. Those results should calibrate provider-specific help text; they must not change the authority model.
