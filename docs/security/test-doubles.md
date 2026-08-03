# Test Doubles and What They Prove

A test double is honest when a reader can tell, without opening it, which
assertions in a suite rest on real behaviour and which rest on a stub answering
the way the test wants. This file is that mapping. Every file in `test/mocks/`
appears below, and `npm run doubles:check` fails when one is added, renamed, or
removed without updating this table.

The distinction that matters is **what the double stands for**:

- **Loom-owned interface.** The double implements an interface defined in
  `src/interfaces/`. The compiler checks the shape, so it cannot drift from what
  the account actually calls. These are ordinary test doubles.
- **External contract.** The double stands for something Loom does not define —
  the ERC-4337 EntryPoint, an ERC-20, a P-256 verifier. Here the shape is *not*
  guaranteed by anything in this repository, and a double that models a
  non-existent method or an impossible answer produces a green suite for a
  configuration that cannot exist on chain. Each of these names the real
  implementation that carries the actual proof.

The rule that follows: **a test may not name, describe, or assert a property
that the installed double answers by fiat.** A stub that always returns `true`
cannot support a claim that the thing it stubs was verified.

## Always-accepting doubles

These answer affirmatively regardless of input. They exist to isolate a
surrounding property, never to establish the one they stub.

| Double | Stands for | Answers | Real proof lives in |
| --- | --- | --- | --- |
| `MockP256Verifier` | `IP256Verifier` (external curve implementation) | every signature valid | `test/evidence/WebAuthnFixtureCorpus.t.sol` (recorded browser assertions through `OZP256Verifier`, one-bit `r` mutation rejected), `test/integration/P256VerifierParity.t.sol` |
| `MockValidator` | `ILoomValidator`, `ILoomDirectValidator` | every signature and direct execution valid | `test/unit/P256Validator.t.sol`, `test/unit/MultiP256Validator.t.sol`, `test/regression/ValidatorBranchCoverage.t.sol` (real ECDSA recovery) |
| `MockPolicyHook` | `ILoomHook`, `IPolicyHook` | every call low risk, no accounting | `test/unit/PolicyHook.t.sol`, `test/integration/MixedValueSpendPolicy.t.sol` |

## Doubles that model a real external shape

| Double | Stands for | Fidelity | Not modelled |
| --- | --- | --- | --- |
| `MockEntryPoint` | the caller the account accepts | does **not** implement `IEntryPoint`; `getNonce` is a constant | nonce sequencing, deposits, prefund, validation loop, `senderCreator` separation — all proven against the real EntryPoint in `test/integration/EntryPoint*.t.sol` and `test/invariant/EntryPointMultiAccountInvariant.t.sol` |
| `MockPaymaster` | ERC-4337 paymaster | implements the real `IPaymaster` from `lib/account-abstraction` | sponsorship economics; postOp gas accounting is exercised through the real EntryPoint |
| `OZP256Verifier` | `IP256Verifier` | real OpenZeppelin P-256 implementation — not a stub | — |
| `MockKeystoreProofVerifier` | `IKeystoreProofVerifier` | re-reads the real `LoomKeystore` and compares every config field and version | the proof itself; storage-proof verification is proven in `test/unit/EthereumL1KeystoreVerifier.t.sol` and `test/unit/OPStackL2KeystoreVerifier.t.sol` |
| `MockERC1271Signer` | ERC-1271 signer | returns the real `0x1626ba7e` magic value only for a pre-set hash and signature pair | — |
| `MockERC20` | ERC-20 | `transfer`, `approve`, `transferFrom` with balances, allowances, and boolean returns | no events, no non-standard return shapes; non-standard tokens are covered in `test/fork/` against real mainnet tokens |
| `MockPayableERC20` | ERC-20 with a payable entry point | as `MockERC20`, plus a payable token call used to construct the mixed native+token shape | has no `receive()`; a native-only transfer to it reverts by design |
| `MockERC7579Validator` | ERC-7579 validator | implements `IERC7579Validator` as transcribed in `src/interfaces/`, with real ECDSA recovery | conformance of that transcription to the published standard is a review obligation, not a compiled guarantee |
| `MockERC7579Hook` | ERC-7579 hook | implements `IERC7579Hook` as transcribed in `src/interfaces/` | as above |
| `MockERC7579HookAdapter` | a Loom hook wrapped in the standard module lifecycle | exercises `ERC7579ModuleAdapter` against a real Loom hook interface | — |

## Adversarial doubles

These exist to make a failure mode reachable. They are meant to misbehave, and
the assertion is that the account survives them.

| Double | Failure it injects |
| --- | --- |
| `DenyPolicyHook` | policy hook that refuses every call |
| `RevertingHook` | hook that reverts in `preCheck` |
| `GasGriefingHook` | hook that burns gas to test the hook gas ceiling |
| `ReentrantHook` | hook that re-enters `execute` |
| `ReentrantModule` | module that re-enters during installation |
| `StorageModifyingHook` | hook that attempts to write account storage |
| `RejectingDirectValidator` | validator that refuses direct execution |
| `PaymasterAwareValidator` | validator that binds an explicit paymaster |
| `InitializerReentrantModule` | module that calls `initialize` back on the account while that account is still inside its own constructor |
| `MockTarget` | ordinary call target with observable state |

## When adding a double

1. Add it to the right table above, with the real proof it does **not** replace.
2. If it stands for an external contract, state where the canonical shape comes
   from. A double for a method the real contract does not expose is a green
   suite for an impossible chain — the failure mode that motivated
   `docs/decisions/0008-op-stack-l2-keystore-verifier.md`'s correction.
3. Do not name a test after a property its installed double answers by fiat.
