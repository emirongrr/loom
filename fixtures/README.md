# Fixtures

Fixtures are deterministic test inputs. They are not production telemetry and
must not contain user secrets, account graphs, raw credential identifiers,
private keys, mnemonics, viewing keys, or persistent device identifiers.

WebAuthn fixtures live under `webauthn/` because their privacy and provenance
rules are stricter than ordinary test vectors. Real browser/device fixtures are
release evidence only after review and mutation-negative tests pass.

