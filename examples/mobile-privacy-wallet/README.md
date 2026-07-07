# Loom Mobile Privacy Wallet

Production-oriented iOS and Android wallet boilerplate for teams building on
Loom. The app is intentionally small, but its boundaries are serious:

- no default RPC, bundler, paymaster, relayer, indexer, or backend;
- no runtime mocks in wallet flows;
- passkey-first account creation through a first-party native module boundary;
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

## Environment

Copy `.env.example` to `.env.local` and provide explicit infrastructure:

```sh
cp examples/mobile-privacy-wallet/.env.example examples/mobile-privacy-wallet/.env.local
```

The app does not ship with a default provider. A missing endpoint disables the
affected flow instead of silently falling back to a hosted service.

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

## Runtime Gates

| Capability | Runtime behavior |
| --- | --- |
| Passkey unavailable | Account creation and signing fail closed. |
| Missing RPC | State reads are disabled. |
| Missing bundler | Transaction submission is disabled. |
| Guardianless account | App shows `unprotected-recovery`. |
| Missing guardian evidence | Guardian setup cannot be submitted. |
| Missing Railgun evidence | Private transfer is disabled. |

## Production Release Checklist

- iOS archive built from a clean checkout.
- Android release build built from a clean checkout.
- App privacy manifest and data safety declarations reviewed.
- No telemetry collecting addresses, credential ids, viewing keys, account
  graph, raw RPC payloads, or private transaction metadata.
- Passkey registration and assertion verified on physical iOS and Android
  devices.
- Loom account deployment rehearsed with explicit RPC and two independent
  bundlers.
- Guardian ceremony rehearsed with proof-of-possession and encrypted backup.
- Railgun privacy adapter profile passes before private send is enabled.
- Deployment manifest and bytecode reproduction evidence published.
