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
- `negativeMutations` is populated only after challenge, origin, RP ID hash,
  user-verification flag, signature, and payload-length negative tests pass;
- the matrix entry remains `captured` until both positive and negative
  contract tests are reviewed, then moves to `verified`.
