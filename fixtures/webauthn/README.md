# Browser-Generated WebAuthn Fixtures

This directory accepts anonymous assertion fixtures captured from real
browsers and authenticators. Fixtures must not contain a username, display
name, credential private key, account address, or persistent device
identifier.

Each fixture records:

- fixture schema version;
- matrix ID and capture date;
- browser, operating-system, and authenticator class;
- authenticator type from the release matrix;
- RP ID and origin used only for the public test domain;
- public key coordinates and credential ID hash;
- authenticator data, client data JSON, and signature;
- expected verification result;
- mutation-negative evidence and WebAuthn behavior notes.

Every accepted positive fixture must have generated negative tests that alter
the challenge, origin, RP ID hash, flags, signature, and payload lengths.

Fixtures are release evidence, not production user telemetry. Collection must
be opt-in and local-first.

`matrix.json` records the minimum release matrix. `npm run fixtures:check`
validates committed fixture shape, matrix membership, low-s signatures,
client-data challenge/origin/type consistency, RP ID hash consistency, and
user-presence/user-verification flags without pretending missing hardware
exists.
`npm run fixtures:release` fails until every required browser/authenticator
combination is marked verified after its positive and mutation-negative
contract tests pass.

`tools/webauthn-fixture/collector.html` creates a fresh local-only credential
and assertion. Serve it from a local secure context, inspect the output, and
remove unnecessary browser metadata before review. Set `matrixId` and
`authenticator` to the matching matrix entry. Fill `negativeMutations` only
after tests cover challenge, origin, RP ID hash, user-verification flag,
signature, and payload-length mutations. A fixture is accepted only after its
positive and mutation-negative Foundry tests pass.
