# Reference WebAuthn Fixtures

Reference fixtures are deterministic WebAuthn-shaped assertion vectors. They
exercise the parser, validation tooling, negative-case manifest, and Solidity
verification harness without making a real-device compatibility claim.

Regenerate the committed reference vector only when the fixture schema or
WebAuthn verifier expectations change:

```sh
node tools/webauthn-fixture/generate-reference-fixture.mjs --out fixtures/webauthn/reference/node-p256.json
```
