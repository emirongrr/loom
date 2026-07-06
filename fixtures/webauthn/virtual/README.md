# Virtual WebAuthn Fixtures

Virtual fixtures are generated during CI or local checks and should normally
remain uncommitted. They are useful e2e evidence for the fixture pipeline, but
they do not prove compatibility with Windows Hello, Apple passkeys, Android
passkeys, YubiKey, or other physical authenticators.

Run:

```sh
npm run webauthn:virtual
```
