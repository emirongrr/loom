# Device Evidence

Several release properties of this wallet cannot be proven from source: they
depend on how a real iOS or Android device behaves. Until a physical-device
session records them, the app must not claim them. This document describes the
evidence bundle that session produces and how it is validated.

Covers the device-evidence gaps in [`GAPS.md`](../GAPS.md): **G-001** (native
passkey registration/assertion), **G-001A** (native domain-policy match),
**G-006** (Helios verified reads on device), **G-009** (screen/keystore/
clipboard hygiene).

## How to use it

1. Copy the template and name it for the target network:

   ```sh
   cp evidence/device-evidence.template.json evidence/device-evidence.sepolia.json
   ```

2. Run the release build on a physical iPhone and a physical Android device and
   fill in every field truthfully. The template ships with placeholder values
   (`PENDING`, `false`) that intentionally fail validation until completed.

3. Validate the bundle:

   ```sh
   npm run evidence:device:check evidence/device-evidence.sepolia.json
   ```

The completed bundle is release evidence; keep it with the store submission
record. Do not commit a real bundle unless the project decides to — only the
template is committed.

## What the validator enforces

The validator (`evidence/validate-device-evidence.mjs`) checks structure and,
more importantly, honesty. It rejects a bundle that:

- records a raw credential id or attestation object as persisted (G-001 — the
  security model forbids persisting either);
- omits either platform for passkey or Helios evidence;
- has a native `Info.plist` / merged-manifest RP id that does not equal the
  pinned `rpId`, or a malformed Android signing certificate hash (G-001A);
- is missing any Helios failure-mode proof — stale checkpoint, unavailable
  consensus, malformed proof, plain-RPC downgrade labelling (G-006);
- claims iOS blocks screenshots (G-009 — iOS cannot; only the app-switcher
  snapshot is covered), or claims Android does not block them.

Because the validator ships with a passing example fixture in its tests, the
schema itself is exercised in CI before any real device data exists — so the
template and the honesty rules cannot silently rot.

The software P-256 key used by the devnet E2E and the app's simulator runs is
not device evidence: it proves the contract path, not that a real platform
authenticator, keystore, or screen-privacy API behaves as claimed.
