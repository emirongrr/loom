# WebAuthn Fixture Corpus

This directory is reserved for accepted browser-generated fixtures captured
from real browsers and authenticators.

Do not add synthetic release fixtures here. Parser tests may use synthetic
fixtures under `tools/`, but production release evidence must come from the
collector flow and must match `fixtures/webauthn/matrix.json`.

Before adding a fixture, verify:

- the credential was created only for the fixture RP ID and origin;
- no username, display name, raw credential ID, raw user-agent, user handle,
  account address, attestation object, or persistent device identifier is
  present;
- `provenance.collectorSourceHash` matches the collector used for capture;
- `provenance.reviewedForPII` is true only after a human privacy review;
- `provenance.negativeCaseManifestHash` binds the fixture to its reviewed
  challenge, origin, RP ID hash, user-verification flag, signature, and
  payload-length negative cases;
- `negativeMutations` is populated only after challenge, origin, RP ID hash,
  user-verification flag, signature, and payload-length negative tests pass;
- the matrix entry remains `captured` until both positive and negative
  contract tests are reviewed, then moves to `verified`.

Generate the negative-case manifest with:

```sh
node tools/webauthn-fixture/negative-cases.mjs fixtures/webauthn/corpus/<fixture>.json
```

The manifest schema is `fixtures/webauthn/negative-case-manifest.schema.json`.
Its hash is review evidence; it is not a substitute for running the negative
mutation tests against the Solidity verifier.
