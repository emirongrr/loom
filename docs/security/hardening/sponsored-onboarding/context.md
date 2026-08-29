# Local Context: Sponsored Onboarding And Private Activation

Source root: repository root.

Evidence inventory:

- `E001` — The former sponsor server prefunded prospective account deposits and submitted `handleOps` separately, allowing stranded or repeated sponsor value on partial failure.
- `E002` — ERC-4337 v0.9 `EntryPoint.handleOps` accepts only a direct EOA bundler caller; a contract wrapper cannot make `depositTo + handleOps` atomic.
- `E003` — `src/OnboardingPaymaster.sol` atomically charges a dedicated paymaster deposit and limits authorization to nonce-zero, empty-call Loom factory activation.
- `E004` — `examples/passkey-wallet-web/sponsor-policy.mjs` binds authorization to deployment, policy, principal quota, global budget, gas cap, and request shape.
- `E005` — `packages/sdk/src/index.ts` provides private-first transport and permits public fallback only after positive proof of pre-acceptance rejection.
- `E006` — `examples/passkey-wallet-web/src/features/wallet/sponsoredActivation.ts` obtains paymaster authorization before the account passkey signs the final UserOperation.
- `E007` — `tools/evidence/validate-passkey-lifecycle-rehearsal.mjs` requires second-device discovery, delayed recovery, recovery-key discovery, and stale-key rejection evidence.

The worktree contains the broader v3 discovery and recovery change set, so source drift is present. This hardening record does not claim a clean release revision or completed Sepolia rehearsal.
