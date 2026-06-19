# Deployment and Verification

Deploy shared validators, the policy hook, and the factory with the scripts in
`script/`. An account is then created deterministically through
`LoomAccountFactory`.

Deployment helpers are split into passkey, authorization, and recovery groups
so each helper remains independently deployable and does not accumulate every
module's creation bytecode in one contract.

## Required checks

1. Verify the EntryPoint address and deployed code hash against the official
   ERC-4337 release.
2. Verify the P-256 fallback verifier address and code hash for every target
   chain. A zero fallback address is acceptable only where the P-256 precompile
   is guaranteed.
3. Publish compiler version, optimizer settings, constructor arguments, salt,
   and resulting bytecode.
4. Verify all deployed contracts on the relevant explorers.
5. Confirm the account has no unexpected validator or hook installed.
6. Confirm the guardian threshold is non-zero and no greater than 32.
7. Confirm the configured primary validator references an installed policy
   hook.
8. Confirm `entryPoint.senderCreator()` exists and its bytecode matches the
   official release.
9. Confirm every installed hook and module implementation is immutable or that
   any mutability is explicitly accepted and independently audited.
10. Complete a guardian proof-of-possession ceremony, independently rebuild
    the Merkle root, verify the threshold can be met, and simulate a recovery
    proposal before funding. The opaque root alone does not prove usability.

## Reproducibility

Production releases must pin the Foundry version and dependency revisions,
build in CI, publish bytecode hashes, and reproduce the same bytecode from a
clean checkout before deployment.

Every candidate deployment must publish a release manifest containing:

- Chain ID and RPC verification date.
- Source revision and clean-worktree confirmation.
- Foundry, Solidity, optimizer, and EVM settings.
- Dependency revisions.
- EntryPoint and sender-creator addresses and code hashes.
- Factory, hook, validator, fallback verifier, and account addresses.
- Constructor arguments, account salt, guardian root, threshold, initial
  `configHash`, and installed modules.
- Creation and deployed bytecode hashes for every Loom contract.
- Explorer verification links and the result of the per-chain smoke tests.

The manifest must be reviewed by a second person before any account receives
production funds. Address prediction must be repeated independently from the
published constructor inputs and salt.

Machine-readable release manifests must pass:

```sh
npm run deployment:manifest:check -- evidence/deployments/<network>.json
```

The validator recomputes bytecode hashes from checked Foundry artifacts and
rejects missing EntryPoint, P-256, explorer, reproducibility, or no-Loom-service
checks. See `docs/operations/deployment-manifest.md` for the schema and
release evidence rules.

Current pinned toolchain and contract dependencies:

- Foundry `v1.7.1`
- Solidity `0.8.35`
- account-abstraction `0.9.0`
- OpenZeppelin Contracts `5.1.0`

See `docs/security/production-readiness.md` for release gates that cannot be satisfied by code
alone.
