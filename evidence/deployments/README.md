# Deployment Evidence

This directory is reserved for production-candidate deployment manifests.

Do not commit placeholder manifests, local runner configs, RPC URLs, API keys,
private keys, or explorer URLs containing credentials. A manifest belongs here
only after a public testnet or production-candidate deployment can be
independently reproduced from a clean checkout.

Validate a candidate with:

```sh
npm run deployment:manifest:check -- evidence/deployments/<network>.json
```

Local `*.config.local.json` inputs and `*.attestations.local.json` signing
payloads are gitignored. The final network manifest is emitted only after all
three EIP-191 signatures validate against one common `evidenceDigest`; an
unsigned or partially signed file is not canonical deployment evidence.

The manual GitHub workflow `deployment-manifest-candidate` runs the same
validation after rebuilding Foundry artifacts. It is intentionally manual so
ordinary pull requests do not pretend to have production deployment evidence.

Sponsored deployments must list `OnboardingPaymaster` like every other contract,
including constructor arguments, immutable runtime words, receipt, block/gas,
and explorer verification. The initial paymaster deposit transaction and live
deposit observation belong in the reviewed release notes/check evidence. Keep
private RPC URLs, authorization keys, API tokens, and credential identifiers out
of committed evidence.
