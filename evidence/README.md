# Evidence

This directory is for public, reproducible evidence that supports release
readiness claims.

Evidence files must be safe to publish and independently reviewable. Do not
commit local runner configs, private RPC URLs, API keys, private keys,
mnemonics, viewing keys, guardian salts, raw device identifiers, or placeholder
claim files.

Use `tools/evidence/` to build or validate evidence artifacts. A file belongs
under `evidence/` only after the corresponding validator passes and the artifact
does not create a false production-readiness claim.

