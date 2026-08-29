# Sepolia Canonical Deployment Evidence Status

Status date: 2026-08-29

## Release decision

`evidence/deployments/sepolia.json` is intentionally not present yet. The latest
local Sepolia broadcast belongs to source commit
`d9d6b484d37c6644743a623b6138330ee6793dc2`, while the current source revision is
`cf09f60cdce2009604acad24ca28e30f7cda699b` with uncommitted protocol and wallet
changes. Publishing the historical broadcast as evidence for the current release
would make a false clean-build and bytecode-reproduction claim.

The final file may be emitted only from a frozen, clean release checkout after
the new deployment, public explorer verification, independent reproduction, and
three valid attestations.

## Historical broadcast inventory

The latest archived broadcast contains 15 top-level `CREATE` transactions and
one constructor-created `AppAccountRegistry`, covering 16 Loom contracts. Its
recorded deployment range is block `11537678` through `11537692`, total gas used
is `22706564`, and the external deployer is
`0x8659eaa644cc30dac6243d69612329bf636f133f`.

This inventory is useful migration input, not current release evidence.

## Live ERC-4337 observation

At Sepolia reference block `11579449`, a direct RPC observation returned:

- EntryPoint v0.9: `0x433709009B8330FDa32311DF1C2AFA402eD8D009`
- EntryPoint runtime hash:
  `0x280d5c7c0de94b512401eb9c4b0ef0436275ff03627aad0ce1f93ab1627187a0`
- SenderCreator: `0x0A630a99Df908A81115A3022927Be82f9299987e`
- SenderCreator runtime hash:
  `0xa7d4dd260bca9c96da49f7c0682fdda7f0074694d935815a336d3e60ee3ec6ad`

The production-candidate evidence must repeat this observation through two
independently operated RPC providers at one agreed reference block.

## Remaining release inputs

- Freeze a full 40-character source commit with a clean worktree.
- Run the complete clean-checkout build and test gate at that commit.
- Perform the new Sepolia deployment and archive its Foundry broadcast.
- Record exact `CREATE/deployer/nonce` or `CREATE2/deployer/salt` coordinates,
  constructor arguments, transaction receipts, blocks, and gas use.
- Observe every runtime hash through two independent RPC operators.
- Record `OnboardingPaymaster` constructor bindings, immutable runtime words,
  initial deposit receipt, live deposit, authorizer/policy/cost getters, and
  credential-free explorer verification.
- Qualify the private transaction provider and validate the complete sponsored
  onboarding/second-device/recovery/stale-key lifecycle evidence.
- Verify every source on a public explorer and record credential-free links.
- Reproduce init code, runtime code, and addresses from a second clean checkout.
- Prepare the common digest and exact signing messages with
  `npm run deployment:attestations:prepare`.
- Collect valid deployer, independent-reproducer, and security-reviewer EIP-191
  signatures and build `evidence/deployments/sepolia.json`.
- Run `npm run deployment:manifest:check -- evidence/deployments/sepolia.json`
  and the manual `deployment-manifest-candidate` workflow.

No unsigned, partially signed, historical, or placeholder JSON belongs at the
canonical path.
