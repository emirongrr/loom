# Deployment Gas

`npm run deployment:gas` reports the real gas each Loom contract's deployment
costs. It deploys the full stack once to a throwaway `anvil` devnet and reads
the per-contract `gasUsed` from the Foundry broadcast receipts, matched to each
CREATE transaction by hash. `gasUsed` is the computational cost of deploying
the bytecode, so these numbers are identical on Sepolia and mainnet — only the
gas price differs.

This is a reporting tool, separate from the E2E lifecycle test; it does not
gate CI.

## Sample output

Measured on anvil (chain 31337) with the current source:

| Contract | Deployment gas |
| --- | ---: |
| LoomAccount (implementation) | 5,544,690 |
| P256RecoveryValidatorFactory | 2,128,760 |
| VaultHook | 1,957,174 |
| GranularSessionValidator | 1,922,124 |
| RecoveryManager | 1,547,293 |
| P256Validator | 1,514,781 |
| PolicyHook | 1,264,976 |
| ExactCallSessionValidator | 751,714 |
| LoomAccountFactory | 732,990 |
| ECDSAValidator | 670,568 |
| **Total (production)** | **18,035,070** |

Excluded from the production total: the vendored ERC-4337 `EntryPoint`
(~3.80M, deployed here only because the devnet has no canonical EntryPoint;
production reuses the on-chain one) and the test-only `DevnetTarget` (~85k).

Numbers shift as the contracts change; re-run the command for current values.
The reusable extractor is `deploymentGasReport` in `@loom/deployment`.
