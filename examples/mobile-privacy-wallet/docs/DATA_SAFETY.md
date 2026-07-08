# Store Privacy Declarations

Draft answers for the Apple App Privacy questionnaire and the Google Play Data
safety form, matching what this codebase actually does. A fork that adds any
collection (analytics, crash reporting, push tokens) must update both
declarations and this file in the same PR.

## What the app actually does

- Collects **no** data: no analytics, no telemetry, no crash reporting, no
  identifiers sent to a developer server. There is no developer server.
- Talks only to user-supplied endpoints (execution/consensus RPC, checkpoint
  source, bundler, optional Railgun infrastructure). Those providers observe
  IP and request metadata — that is transport exposure, not collection by the
  app, and it is documented in `PRIVACY_MODEL.md` ("Network metadata").
- Persists locally only allowlisted values through the platform-encrypted
  store (`src/platform/secureStore.ts`): the credential id hash and the
  encrypted guardian backup. Device-only; excluded from cloud backups.
- Biometric/passkey data never leaves the platform authenticator. The app
  receives only P-256 public coordinates and a credential id hash.

## Apple App Privacy (App Store Connect)

| Question | Answer |
| --- | --- |
| Data collection | **Data Not Collected** |
| Tracking (`NSPrivacyTracking`) | `false` (declared in `app.json` `ios.privacyManifests`) |
| Tracking domains | none |
| Accessed API categories | User defaults (`CA92.1` — app's own settings via the Expo runtime) |

The app-level privacy manifest is generated from `app.json`
(`ios.privacyManifests`) at prebuild; third-party SDK manifests (React Native,
Expo modules) ship inside those packages.

## Google Play Data safety

| Section | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **No** |
| Is all of the user data collected by your app encrypted in transit? | Not applicable (no collection); endpoint traffic is HTTPS-or-localhost enforced in `src/verified/helios.ts` |
| Do you provide a way for users to request that their data is deleted? | Not applicable — all state is on-device; deleting the app deletes it |
| Data types: personal info, financial info, location, contacts, identifiers, usage data, diagnostics | None collected, none shared |
| Security practices | Data is not collected; local secrets use the platform-encrypted keystore |

## Release checks

- Re-run the store questionnaires whenever a dependency adds a privacy
  manifest or a new permission appears in the merged Android manifest.
- Verify the shipped `PrivacyInfo.xcprivacy` (after `expo prebuild`) matches
  the `app.json` declaration.
- Attach both store declarations to the release evidence (G-009 in
  `GAPS.md`).
