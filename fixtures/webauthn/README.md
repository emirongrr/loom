# Browser-Generated WebAuthn Fixtures

This directory accepts anonymous assertion fixtures captured from real
browsers and authenticators. Fixtures must not contain a username, display
name, credential private key, account address, or persistent device
identifier.

Each fixture records:

- fixture schema version;
- matrix ID and capture date;
- browser, browser version, operating-system label/version, and authenticator
  class;
- authenticator type from the release matrix;
- authenticator transport evidence;
- hashed user-agent evidence for review deduplication;
- RP ID and origin used only for the public test domain;
- public key coordinates and credential ID hash;
- authenticator data, client data JSON, and signature;
- expected verification result;
- mutation-negative evidence and WebAuthn behavior notes.
- provenance proving the fixture came from the browser/device capture flow, used a fresh
  fixture-only credential, passed PII review, and is bound to a negative-case
  manifest hash.

The fixture tree has two evidence tiers:

- `reference/` contains deterministic standard-shape vectors. These prove the
  parser, fixture validator, and Solidity verification harness understand the
  WebAuthn wire format. They are not real-device evidence.
- `corpus/` contains reviewed real browser/device assertions. Only this
  directory can satisfy release evidence for Windows Hello, Android passkeys,
  Apple passkeys, YubiKey, or other physical authenticators.

The real-device corpus is intentionally empty until a real browser/device
assertion is captured. Do not commit generated examples as release evidence. A
fixture only becomes release evidence when the matrix entry, positive
assertion, negative case manifest, and reviewed mutation results all agree.

Every accepted positive fixture must have generated negative tests that alter
the challenge, origin, RP ID hash, flags, signature, and payload lengths.

Fixtures are release evidence, not production user telemetry. Collection must
be opt-in and local-first. Do not commit usernames, display names, raw
credential IDs, raw user-agent strings, user handles, attestation objects,
account addresses, or persistent device identifiers.

`matrix.json` records the minimum release matrix. `npm run fixtures:check`
validates committed fixture shape, matrix membership, low-s signatures,
client-data challenge/origin/type consistency, RP ID hash consistency, and
user-presence/user-verification flags without pretending missing hardware
exists.
`npm run fixtures:release` fails until every required browser/authenticator
combination is marked verified after its positive and mutation-negative
contract tests pass.

Browser/device corpus fixtures are generated with real browsers and real
authenticators. Inspect the output and keep only the anonymous metadata
required by `schema.json`. Set `matrixId`,
`browser`, `platform`, `authenticator`, `authenticatorClass`, and `transports`
to the matching matrix entry. Fill `negativeMutations` only after tests cover
challenge, origin, RP ID hash, user-verification flag, signature, and
payload-length mutations. Set `provenance.reviewedForPII` only after checking
that no raw credential identifier, user handle, username, display name, raw
user-agent, attestation object, account address, or persistent device
identifier is present.

For account lifecycle evidence, the WebAuthn challenge must be the exact
ERC-4337 `userOpHash` (or the exact direct-execution digest) that the account
will validate. Random challenge fixtures prove browser/authenticator
compatibility, but they cannot honestly prove deploy-and-spend behavior.

Commit lifecycle fixtures only after the resulting assertion is exercised
through the same account path it claims to cover: counterfactual deployment,
prefunding, EntryPoint validation, execution, balance or target-state change,
and negative mutation rollback/no-spend checks.

Set `provenance.negativeCaseManifestHash` to the manifest hash only after the
reviewed negative-case manifest is generated from the accepted fixture outside
the repository and its challenge, origin, RP ID hash, user-verification flag,
signature, and payload-length mutations are exercised against the Solidity
verifier tests. A fixture is accepted only after its positive and
mutation-negative tests pass.

Put accepted fixtures under `corpus/`. Missing combinations must remain
marked `missing` in `matrix.json`; do not add synthetic production fixtures to
make a release gate pass.
