# Threat Model

Scope: the mobile client boilerplate, not the Loom contracts (those have their
own threat model in the repository root `docs/security/threat-model.md`). For
each threat: the risk, what this example already does, the remaining gap, and
the production recommendation.

| Threat | Risk | Current mitigation | Remaining gap | Production recommendation |
| --- | --- | --- | --- | --- |
| Malicious RPC provider | Forged balances/nonces/recovery state | Helios-first verified reads; plain RPC labeled `unverified` | Helios device evidence (G-006) | Ship Helios-verified reads; never present plain RPC as verified |
| Malicious bundler | Censors or de-anonymizes UserOps | Explicit, replaceable bundler; no default | Multi-bundler UI/evidence (G-003) | Support ≥2 independent bundlers and provider switching |
| Malicious frontend/client | Tricks user into a bad operation | Clear-signing review from the SDK; no hidden network calls | Full clear-signing UX | Show decoded intent + authority for every op |
| Lost device | Attacker has the phone | Passkey requires user verification (biometric/PIN); private key in secure hardware | — | Enforce device lock; rely on guardian recovery |
| Lost passkey | User cannot sign | Guardian recovery replaces the validator | Guardian ceremony evidence (G-004) | Prompt recovery setup after onboarding |
| Compromised session key | Bounded misuse until expiry | Sessions are scoped (target/selector/token/amount/uses/expiry); revocable | Session UI + post-compromise flow | Show active sessions; one-tap revoke |
| Malicious guardian | Guardian abuses recovery | Loom recovery is timelocked, cancellable, and grants no spending authority | Guardian-graph privacy review | Threshold guardians on independent devices |
| Metadata leakage | Device/IP/timing correlation | No analytics/telemetry; no sensitive logs; metadata budget enforced before private send | Network-level metadata unaddressed (PRIVACY_MODEL.md "Network metadata", G-008) | Add transport privacy before making metadata claims |
| Address clustering | On-chain linkage of activity | — (public transfers are public) | No graph privacy | Use shielded transfers once enabled |
| Replay attacks | Reused signature/challenge | Fresh 32-byte non-zero registration challenge; native modules reject stale/zero challenges | — | Keep challenge generation in app runtime |
| Phishing origin / wrong RP ID | Credential bound to attacker origin | RP id + origin pinned in native build policy; JS cannot expand it; empty origin blocks creation | Release evidence that shipped policy matches (G-001A) | Verify associated domains + signing origin in release |
| Fake deployment manifest | Trusting attacker contract addresses | `verifyDeploymentAgainstManifest` refuses addresses not matching a committed manifest | On-chain codehash confirmation | Confirm manifest code hashes on chain before first use |
| Supply-chain dependency compromise | Malicious npm/native dep | Minimal deps; first-party native passkey module | No SBOM/pinning here | Pin, audit, and reproduce dependency builds |
| Debug build leakage | Debug logs expose data | No sensitive logging; no debug secrets committed | No enforced log policy in CI | Strip logs in release; add a log-safety lint |
| Insecure logs | Sensitive data in logs | Documented never-log list (README security model) | Not lint-enforced | Add a privacy-safe logging wrapper + test |
| App store compromise | Tampered binary | Native RP/origin pinning limits credential misuse | Out of app scope | Rely on store signing + associated domains |
