# Loom Mobile Privacy Wallet

Production-oriented iOS and Android wallet boilerplate for teams building on
Loom. The app is intentionally small, but its boundaries are serious:

- no default RPC, bundler, paymaster, relayer, indexer, or backend;
- no runtime mocks in wallet flows;
- passkey-first account creation through a first-party native module boundary;
- Helios-first verified state reads instead of trusting a raw RPC response;
- progressive recovery shown honestly when guardians are not configured;
- private transfer UI gated behind Railgun privacy evidence;
- every blocked production path recorded in `GAPS.md`.

This example is not a closed Loom product. It is a client template that another
wallet, fintech, bank, or application team can fork and harden while preserving
user sovereignty.

## Stack

- Expo Dev Client
- React Native
- TypeScript strict mode
- First-party native passkey module boundary under `modules/loom-passkey`
- Loom SDK packages from this repository

Native implementation references:

- Apple `AuthenticationServices` platform public-key credentials:
  https://developer.apple.com/documentation/authenticationservices/asauthorizationplatformpublickeycredentialprovider
- Android Credential Manager passkeys:
  https://developer.android.com/identity/sign-in/credential-manager
- Expo native modules:
  https://docs.expo.dev/modules/native-module-tutorial/

The native passkey module creates platform credentials with user verification
required and only returns P-256 public coordinates plus a credential id hash. If
the native module is unavailable or a platform capability is missing, the
wallet flow fails closed and reports a configuration error.

The native module is not allowed to accept arbitrary WebAuthn relying-party
settings from the JavaScript layer. Each production app build must pin its
passkey domain policy in native configuration:

- iOS `Info.plist`:
  - `LoomPasskeyRpId`
  - `LoomPasskeyAllowedOrigins`
- Android application metadata:
  - `org.loom.passkey.RP_ID`
  - `org.loom.passkey.ALLOWED_ORIGINS`

The JavaScript configuration must match the native policy, but it cannot expand
it at runtime. Registration and assertion responses are rejected unless
`clientDataJSON.type`, `clientDataJSON.challenge`, `clientDataJSON.origin`,
`authenticatorData.rpIdHash`, user presence, and user verification match the
native policy and the caller-provided challenge.

Loom intentionally uses `attestation: "none"` for passkey registration. The
wallet does not rely on vendor attestation or device identity. Account security
is based on WebAuthn user verification, account-level validation, timelocked
recovery, policy limits, and release evidence rather than device-vendor
fingerprinting.

## Security Model

Biometric data is not a wallet key. Face ID, Touch ID, Android biometrics, and
device PINs authorize use of a platform credential. The credential private key
stays in the platform credential manager and secure hardware where available.

The app must never persist:

- raw credential identifiers unless encrypted locally and strictly required;
- attestation objects;
- raw user agent strings;
- viewing keys;
- account graph data;
- raw private transaction metadata.

That rule is enforced in code, not just documented. Local persistence must go
through `src/platform/secureStore.ts`, which allows only allowlisted keys
(credential id hash, encrypted guardian backup) on top of the
platform-encrypted store, and rejects anything that names forbidden material.

Screen and clipboard hygiene:

- `modules/loom-screen-privacy` applies Android `FLAG_SECURE` (blocks
  screenshots, screen recording, and the recents thumbnail) and covers the
  iOS app-switcher snapshot with a blur overlay. iOS cannot block
  screenshots; the app must not claim that it does.
- `src/platform/clipboardHygiene.ts` clears copied addresses after a TTL, and
  only if the clipboard still holds the value the wallet placed there.
- Store privacy declarations (Apple App Privacy, Google Play Data safety) are
  drafted in `docs/DATA_SAFETY.md` and pinned by `app.json`
  `ios.privacyManifests`.

## Environment

Copy `.env.example` to `.env.local` and provide explicit infrastructure:

```sh
cp examples/mobile-privacy-wallet/.env.example examples/mobile-privacy-wallet/.env.local
```

The app does not ship with a default provider. A missing endpoint disables the
affected flow instead of silently falling back to a hosted service.

State reads are Helios-first. Helios still needs user-supplied execution and
consensus endpoints as data transports plus a weak-subjectivity checkpoint. The
wallet treats those endpoints as replaceable transports, not as trusted sources
of balances, nonces, recovery state, guardian roots, vault state, or validator
state.

Plain RPC state reads are available only when `EXPO_PUBLIC_LOOM_STATE_MODE=rpc`
is chosen explicitly. The UI and SDK must label that mode as unverified.

## Quickstart

First deployment (one command once the Sepolia env file is filled):

```sh
# 1. Fill SEPOLIA_RPC_URL and SEPOLIA_DEPLOYER_PRIVATE_KEY in .env.sepolia.local
npm run bootstrap        # deploy -> connect -> verify env == manifest == chain
npm run bundler:local    # self-hosted ERC-4337 bundler on localhost:4337 (optional)
npm run start
```

`npm run start` (and `run android` / `run ios`) runs a preflight first: if the
app is not connected to a verified Loom deployment it lists exactly which
fields are empty and how to fill them, then refuses to start. UI-only work
without a deployment: `LOOM_ALLOW_UNCONFIGURED=1 npm run start`.

Deployment lifecycle:

| Command | Effect |
| --- | --- |
| `npm run bootstrap` | Deploy to Sepolia, connect the app, verify env == manifest == chain. |
| `npm run start` | Run the app; preflight requires a connected deployment. |
| `npm run deployment:remove` | Disconnect the app (archive manifest, clear env fields). Contracts are immutable and stay on chain; reconnect any time with `bootstrap` or `deploy:connect`. |

This example uses the repository deployment tooling instead of carrying a
parallel app-only deployment stack. Core tools build and validate manifests,
summarize Foundry broadcasts, and keep transaction evidence reproducible; the
example stores only app-specific Sepolia rehearsal evidence in
[`docs/sepolia-deployment-evidence.md`](docs/sepolia-deployment-evidence.md).
The live `deployment/sepolia.manifest.json` stays local-only and the committed
file remains a placeholder. The shared toolkit is documented in
[`../../docs/operations/wallet-deployment-toolkit.md`](../../docs/operations/wallet-deployment-toolkit.md).

## Development

From this directory:

```sh
npm install
npm run typecheck
npm run lint
npm run start
```

Native development requires an Expo Dev Client build:

```sh
npm run prebuild
npm run ios
npm run android
```

The first store-ready release must add real iOS and Android device evidence,
privacy adapter evidence, and deployment manifests listed in `GAPS.md`.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layout and separation of concerns.
- [`docs/PRIVACY_MODEL.md`](docs/PRIVACY_MODEL.md) — which privacy layers are and are not addressed.
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) — keys, passkeys, sessions, storage rules.
- [`docs/TRUST_ASSUMPTIONS.md`](docs/TRUST_ASSUMPTIONS.md) — what is and is not trusted.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — per-threat risk, mitigation, gap, recommendation.
- [`docs/RECOVERY_MODEL.md`](docs/RECOVERY_MODEL.md) — progressive vs organization recovery.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — manifest verification of contract addresses.
- [`docs/sepolia-deployment-evidence.md`](docs/sepolia-deployment-evidence.md) — app-specific Sepolia rehearsal evidence produced from repository deployment tooling.
- [`docs/DEVICE_EVIDENCE.md`](docs/DEVICE_EVIDENCE.md) — the physical-device evidence bundle (G-001/G-001A/G-006/G-009) and its validator.
- [`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md) — evidence required before shipping.
- [`GAPS.md`](GAPS.md) — every blocked production path.

## Screens

The home screen switches between three sections wired to the real flows — no
simulated results anywhere:

- **Status** — capability cards driven by `configurationReadiness`, the state
  readiness gate, and the screen privacy shield.
- **Create account** — generates a fresh 32-byte CSPRNG challenge
  (`src/platform/challenge.ts`, expo-crypto), calls the native passkey module,
  and renders the `createAccountFlow` result: blocking gates as-is, or the
  registration summary with an explicit `unprotected-recovery` warning.
- **Private send** — calls `preparePrivateSend` and renders its gates. Once a
  privacy profile passes, the same screen shows the metadata budget the user
  must see before an operation is built.

## Bundler

The app never ships a default bundler; any ERC-4337 bundler is a replaceable
transport. Two standard options:

- **Self-hosted** — run Pimlico's open-source Alto against Sepolia with the
  same env file as the deployment: `npm run bundler:local` (listens on
  `http://localhost:4337`; the executor key fronts gas and is refunded by the
  EntryPoint). This is the sovereignty path. Alto receives the executor key
  through CLI flags, so local process-inspection tools may see it while the
  bundler is running; use only a low-balance Sepolia rehearsal key, never a
  production deployer or user key.
- **Hosted** — Pimlico, Alchemy, Biconomy, etc. This is the managed path most
  production wallets use, typically with two independent providers and
  failover (G-003 tracks the qualification evidence).

Either URL goes into `EXPO_PUBLIC_LOOM_BUNDLER_URL` or the in-app Settings
screen at runtime.

## Network Metadata

Every configured endpoint — execution RPC, consensus RPC, checkpoint source,
bundler, and (when enabled) Railgun relayer/indexer/prover — observes the
device IP, request timing, and query patterns. This example does not route
traffic through a proxy, Tor, or mixnet; do not present it as hiding network
metadata. The per-endpoint leak surface and residual risk are documented in
[`docs/PRIVACY_MODEL.md`](docs/PRIVACY_MODEL.md) and tracked as G-008 in
[`GAPS.md`](GAPS.md).

## Runtime Gates

| Capability | Runtime behavior |
| --- | --- |
| Incomplete configuration | Account creation is blocked; no chain, origin, or provider is assumed. |
| Deployment addresses unverified | Blocked until they match a committed deployment manifest. |
| Passkey unavailable | Account creation and signing fail closed. |
| Missing Helios checkpoint or transport | Verified state reads are disabled. |
| Plain RPC mode | State reads are explicitly unverified. |
| Missing bundler | Transaction submission is disabled. |
| Guardianless account | App shows `unprotected-recovery`. |
| Missing guardian evidence | Guardian setup cannot be submitted. |
| Missing Railgun evidence | Private transfer is disabled. |
| Metadata budget not acknowledged | Private send is blocked until the adapter's disclosure budget is surfaced and acknowledged. |
| Invalid session permission | Session grants without explicit key, target, limits, and future expiry are rejected. |

## Production Release Checklist

- iOS archive built from a clean checkout.
- Android release build built from a clean checkout.
- App privacy manifest and data safety declarations reviewed.
- No telemetry collecting addresses, credential ids, viewing keys, account
  graph, raw RPC payloads, or private transaction metadata.
- Passkey registration and assertion verified on physical iOS and Android
  devices.
- Native passkey RP ID and allowed origins pinned in iOS/Android build metadata.
- Passkey registration challenge generated as fresh 32-byte non-zero entropy;
  no zero or static bootstrap challenge.
- P-256 verifier mode recorded from the deployment manifest:
  `native-precompile` when the chain has reviewed protocol-level support, or
  `fallback-contract` only when the fallback contract code hash matches the
  audited verifier.
- Helios verified state sync rehearsed on target iOS and Android devices with
  user-supplied execution RPC, consensus RPC, and checkpoint.
- Loom account deployment rehearsed with explicit RPC and two independent
  bundlers.
- Guardian ceremony rehearsed with proof-of-possession and encrypted backup.
- Railgun privacy adapter profile passes before private send is enabled.
- Deployment manifest and bytecode reproduction evidence published.
- Screen privacy verified on physical devices: Android screenshot and recents
  thumbnail blocked; iOS app-switcher snapshot covered (G-009).
- Secure store contents audited against the allowlist after reboot/restore;
  no raw credential ids or attestation objects on disk.
- Store privacy declarations submitted exactly as drafted in
  `docs/DATA_SAFETY.md`; re-checked after any dependency change.
