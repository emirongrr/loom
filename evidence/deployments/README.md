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

The manual GitHub workflow `deployment-manifest-candidate` runs the same
validation after rebuilding Foundry artifacts. It is intentionally manual so
ordinary pull requests do not pretend to have production deployment evidence.
