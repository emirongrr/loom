# Sepolia Deployment Evidence

This note explains the July 2026 Sepolia rehearsal deployment used by this
mobile wallet example without turning the live mobile manifest into repository
state. The deploy broadcast remains the source for transaction-level evidence.

Generate the current broadcast summary with:

```sh
npm run deployment:sepolia:summary
```

The command is Loom core tooling. This example consumes it as part of the app
deployment workflow, then stores the app-specific evidence here. The command
reads `broadcast/DeploySepolia.s.sol/11155111/run-latest.json` and prints a
Markdown table with contract name, address, transaction hash, block, gas used,
effective gas price, and ETH cost.

## Count Reconciliation

The deployment output can look like 17 addresses, but those are not 17 newly
deployed contracts.

- The Foundry broadcast records 13 top-level `CREATE` transactions.
- `LoomAccountFactory` deploys `AppAccountRegistry` inside its constructor, so
  Loom-created contract count is 14.
- The `SepoliaDeployment` event also records the deployer EOA, the existing
  ERC-4337 EntryPoint, and the native P-256 precompile. Those three addresses
  are part of the runtime wiring, not new contracts deployed by Loom.

## Address Roles

| Address | Component | Role |
| --- | --- | --- |
| `0x8659eaa644cc30dac6243d69612329bf636f133f` | Deployer EOA | Broadcast sender for the rehearsal deployment; not a wallet runtime authority. |
| `0x433709009B8330FDa32311DF1C2AFA402eD8D009` | EntryPoint | Existing ERC-4337 EntryPoint used by account creation and user operation validation. |
| `0x0000000000000000000000000000000000000100` | P-256 precompile | Native verifier selected for P-256 signature checks. |
| `0xceda8174e7943765993bd09c6d714a0a3d1dd82a` | PolicyHook | Account-scoped policy and spend-limit hook. |
| `0xe2e6f5aec60ce04fbb81ec9d4527b06849deb3d2` | VaultHook | Hook surface for vault-related account controls. |
| `0x16a89ee80b6d57a3b0518315f0a2d9947106295f` | ECDSAValidator | Owner-key validator for ECDSA rehearsal and fallback flows. |
| `0xd86b5531361f6382342f59700ff1b309919eaf0a` | P256Validator | Primary passkey validator for single P-256 public keys. |
| `0x5becaf244da8e6b8bf20af8f5bd943474d3c1d58` | MultiP256Validator | Validator for multi-key P-256 account configurations. |
| `0x7521ebf52dcbb1359578525091868e87f3fccbd3` | ExactCallSessionValidator | Session validator for exact-call scoped permissions. |
| `0x624b67e6962d204979a3ea475e1c98ab5fc71a6c` | GranularSessionValidator | Session validator for more granular permission policies. |
| `0x245d394e4ce2f63679cd776d0af408921452caf0` | RecoveryManager | Recovery flow coordinator. |
| `0x7f3fecc48c9737473a56aba46fb81ff558dc3e4b` | ECDSAGuardianVerifier | Guardian verifier for ECDSA signatures. |
| `0x311769c5d86f9114b5ba0b3839eec434c2cc783f` | P256GuardianVerifier | Guardian verifier for P-256 signatures. |
| `0x81a12a6946e05e8d203bc9f3b5dd252846251245` | ERC1271GuardianVerifier | Guardian verifier for contract signatures. |
| `0x708e5c9c53a0e129ead9b14a73ebd891e2d0ca24` | LoomAccount | Shared account implementation used by factory-created accounts. |
| `0x2d8610879998c90c0539d4668e5d3a5297a68d6e` | LoomAccountFactory | Account factory that deploys deterministic account proxies and owns the app registry. |
| `0x0a2f2c8833d92ca89c55f1fe81426c7d93722ce5` | AppAccountRegistry | Constructor-created registry for factory-created app accounts. |

## Gas Summary

- Chain: `11155111`
- Source commit: `0519595`
- Top-level `CREATE` transactions: 13
- Constructor-created contracts: 1
- Loom-created contracts: 14
- Total deploy gas: 18,606,746
- Total ETH cost: 0.019622918741421034

| Contract | Address | Tx hash | Block | Gas used | Gas price | ETH cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| PolicyHook | `0xceda8174e7943765993bd09c6d714a0a3d1dd82a` | `0xfa50ac1de0b795bb09b72c7c187bd2f98c2928db6ca8bd2db72fb9c724450dac` | 11238560 | 1,255,444 | 1.054797677 gwei | 0.001324239414803588 |
| VaultHook | `0xe2e6f5aec60ce04fbb81ec9d4527b06849deb3d2` | `0x478db1d8f9066be410f5a3f7c516e4ebc28d4b87f62eba276a3dedfd230b3619` | 11238560 | 1,851,827 | 1.054797677 gwei | 0.001953302817805879 |
| ECDSAValidator | `0x16a89ee80b6d57a3b0518315f0a2d9947106295f` | `0x15d1945d7913667534ac1a20bc966268beb5d9a9b316875af05efeaf39bfce9e` | 11238560 | 670,568 | 1.054797677 gwei | 0.000707313568670536 |
| P256Validator | `0xd86b5531361f6382342f59700ff1b309919eaf0a` | `0x4555205e778482c07803eedf04b7d2f30b2bf6d290b9f61263b4749ad3e91125` | 11238560 | 1,483,873 | 1.054797677 gwei | 0.001565185793363021 |
| MultiP256Validator | `0x5becaf244da8e6b8bf20af8f5bd943474d3c1d58` | `0xa2d510a38d37b4be99e42c4d138fc038a23223aa1e7e8acd4a2db55a0e7f27fa` | 11238560 | 1,962,764 | 1.054797677 gwei | 0.002070318907699228 |
| ExactCallSessionValidator | `0x7521ebf52dcbb1359578525091868e87f3fccbd3` | `0x58522cbb07f437525f54c26e9bc48d6d093880bc1120c023085a17387078514f` | 11238560 | 751,714 | 1.054797677 gwei | 0.000792906180968378 |
| GranularSessionValidator | `0x624b67e6962d204979a3ea475e1c98ab5fc71a6c` | `0x62f799f22557198af9f94333ca1b976d3deed22c5260950acce59d85ea6e6ace` | 11238560 | 1,826,576 | 1.054797677 gwei | 0.001926668121663952 |
| RecoveryManager | `0x245d394e4ce2f63679cd776d0af408921452caf0` | `0x18035e72e5ee292303fa4715d0b1a099811bafd73d0a7f892a38dd5041dfcf29` | 11238560 | 1,534,099 | 1.054797677 gwei | 0.001618164061488023 |
| ECDSAGuardianVerifier | `0x7f3fecc48c9737473a56aba46fb81ff558dc3e4b` | `0x80265e980249b75b0c07c92f518d05987fc1f0c200209a0d64eda36900ba5ce0` | 11238560 | 200,508 | 1.054797677 gwei | 0.000211495372619916 |
| P256GuardianVerifier | `0x311769c5d86f9114b5ba0b3839eec434c2cc783f` | `0x6a553635780d0659c59d1fbab409edcb9e5d355f1328c80498d9c1df1bce827a` | 11238560 | 927,335 | 1.054797677 gwei | 0.000978150803800795 |
| ERC1271GuardianVerifier | `0x81a12a6946e05e8d203bc9f3b5dd252846251245` | `0xef5da7396ba5439ea3433c3cb9d52960d636535871408efee0e243f9697e6a23` | 11238560 | 202,344 | 1.054797677 gwei | 0.000213431981154888 |
| LoomAccount | `0x708e5c9c53a0e129ead9b14a73ebd891e2d0ca24` | `0x70e647a5732c138d8a9f53e9a58622be91d1f4f1763cc28abc2ce12e3f91c909` | 11238560 | 5,206,737 | 1.054797677 gwei | 0.005492054092349949 |
| LoomAccountFactory | `0x2d8610879998c90c0539d4668e5d3a5297a68d6e` | `0x17fc2070b41d022366a559f545016f243cc4846f29064fd9ae02f0339f9ca202` | 11238561 | 732,957 | 1.050112933 gwei | 0.000769687625032881 |

`AppAccountRegistry` was created inside the `LoomAccountFactory` constructor at
`0x0a2f2c8833d92ca89c55f1fe81426c7d93722ce5`; its gas is included in the
factory transaction above.

## Best-practice Assessment

The modular deployment is acceptable for this rehearsal stage. The shared
implementation, factory, validators, hooks, recovery manager, and guardian
verifiers keep authority surfaces reviewable and independently testable. A
single monolithic deployment would reduce the address count, but it would also
couple unrelated trust boundaries and make future audit evidence less precise.

Cost optimization should be handled through a separate ADR if it becomes a
release goal. This evidence PR should not collapse modules or introduce new
factory behavior.

Live mobile manifests remain local-only. Keep this example's
`deployment/sepolia.manifest.json` as the placeholder in git and use deployment
evidence documents for reviewed public addresses.
