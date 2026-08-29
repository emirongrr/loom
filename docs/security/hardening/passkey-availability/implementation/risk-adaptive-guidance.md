# Implementation Plan: Risk-Adaptive Post-Onboarding Guidance

## Selected Design And Constraints

Onboarding remains one native WebAuthn action. Availability metadata is advisory; locator data is discovery-only; live validator assertions remain authoritative. Loom does not export credentials or select providers.

## Source Revision And Drift Check

Planning base: `cf09f60cdce2009604acad24ca28e30f7cda699b`. Evidence inventory digest: `741dce335dc8a9a53c8a9a33685aacec2e4b5d8530d5eb439fce59aa2328d255`. Source drift was present because this work extends the active v3 discovery branch.

## Affected Components

Account types/store, browser WebAuthn lifecycle, recovery session/save paths, app discovery/unlock flow, Security UI, onboarding copy, styles, and web tests.

## Ordered Work Packages

1. Add and validate optional verified backup observations.
2. Return fresh observations from verified assertions and persist them after registration, unlock, discovery, and recovery.
3. Remove the BE=0 block while retaining post-registration assertion and impossible flag-state rejection.
4. Add Security classification, refresh, choices, guardian navigation, and presentation-only dismissal.
5. Verify focused and complete web gates; rehearse physical devices before release.

## Compatibility And Migration

The observation and recovered account handle remain optional when reading existing v3 records. New creation, recovery, and discovery flows populate them. No legacy wallet namespace is imported.

## Tactical Protections During Migration

Keep the post-registration assertion, RP/origin/UP/UV checks, v3 locator validation, live validator-key discovery check, and stale-key refusal enabled throughout rollout.

## Tests And Security Validation

Cover all four availability states, malformed dismissal state, authenticator-bound recovery, persisted session material, account-store validation, stale live keys, TypeScript, components, and production build.

## Performance And Resource Benchmarks

No chain hop is added. Compare unlock timing before/after the bounded local-storage update; reject the change if it produces a user-visible extra ceremony or network request. The Security refresh intentionally performs one ceremony.

## Rollout And Rollback

Roll out as an optional-metadata UI feature. The Security card and metadata writes can be reverted without changing on-chain state. Never revert assertion or live-key authority checks as part of a UI rollback.

## Acceptance Criteria

- A new wallet is created with one native passkey action and no backup warning gate.
- `BE=0` can complete recovery after the new credential assertion succeeds.
- Security distinguishes unknown, authenticator-bound, sync-pending, and backed-up observations.
- Dismissal hides recommendations only for that account.
- A synced v3 credential on a second device resolves the same account and succeeds only under the live validator key.
- Typecheck, domain tests, component tests, and production build pass.

## Open Decisions

Define the release device/provider matrix and whether dismissals expire after key rotation.
