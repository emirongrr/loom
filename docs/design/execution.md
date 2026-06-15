# Loom Execution Profile

Loom exposes the canonical execution entry point:

```solidity
execute(bytes32 mode, bytes executionCalldata)
```

Only the EntryPoint or the account itself may call it. The account also
exposes `executeDirect`, a provider-independent publication path. Any caller
may relay a direct execution, but it succeeds only with an installed validator
that explicitly implements `ILoomDirectValidator`.

Direct signatures bind the account, chain, validator, mode, execution calldata,
validator-scoped monotonic direct nonce, current `configVersion`, and expiry. Direct execution
then enters the same `execute` authorization body, freeze checks, hooks, policy
accounting, and atomic execution behavior as EntryPoint execution. Session
validators deliberately do not implement the direct-validator interface.

Hooks receive the external transaction publisher as `caller` on the direct
path. A hook must treat this value as transport context, not account authority;
authorization comes from the direct validator and signed digest.

Each direct-capable validator has an independent nonce sequence. One installed
credential profile therefore cannot invalidate another profile's pre-signed
fallback operation merely by publishing its own direct execution. A failed
validation, hook, or inner call rolls back the nonce increment.

## Supported modes

| Call type | Mode prefix | Calldata encoding | Behavior |
|---|---|---|---|
| Single | `0x00 0x00` | `abi.encode(Execution(target, value, callData))` | Executes one call |
| Batch | `0x01 0x00` | `abi.encode(Execution[])` | Executes a non-empty atomic ordered batch |

All remaining mode bytes must be zero. Delegatecall, try-mode, executor calls,
and fallback execution are unsupported and revert.

An `Execution` is:

```solidity
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}
```

The single-call encoding is Loom-specific and is not the packed single-call
encoding defined by ERC-7579.

## Guarantees

- A batch executes in array order.
- If any item fails, every earlier state and value transfer in the batch rolls
  back.
- Empty batches and zero-address targets revert.
- Each item may transfer ETH held by the account.
- A caller may fund the account and execute the batch in the same payable
  call.
- Hooks run around the complete batch, and policy accounting for failed
  batches rolls back.
- `supportsExecutionMode` reports only the two supported modes.
- Failed inner calls bubble their revert data.

## Wallet and bundler integration

A wallet client creates one UserOperation whose `callData` invokes `execute`.
A batch request is therefore one atomic UserOperation, not multiple
independent UserOperations.

The canonical batch mode follows ERC-7821's minimal single-batch encoding and
authorization model. Loom does not implement ERC-7821 opData or recursive
batch-of-batches modes.

ERC-5792 remains a wallet-client RPC responsibility. A future client must
report only capabilities that have corresponding conformance and integration
tests.

## Sovereign migration

`scheduleMigration` creates a visible, delayed, cancellable exit intent. The
intent commits to:

- destination account;
- destination runtime code hash;
- destination `configHash`;
- exact atomic call batch hash;
- current source `configVersion`;
- source migration nonce;
- execution delay and expiry;
- current chain ID through `migrationIdFor`.

The account itself must schedule and cancel migrations through `execute`, so a
normal validator cannot silently bypass graded access. Once ready, anyone can
publish `executeMigration`; this supports the walkaway test when the original
wallet client, bundler, or frontend is unavailable.

Execution remains conservative:

- migration cannot run while the account is frozen;
- migration cannot run before `readyAt`, after `expiresAt`, or after a source
  config change;
- destination code and destination config must still match the commitment;
- the call batch must match the committed hash exactly;
- the batch is atomic;
- active hooks receive a synthetic batch `execute` call and can enforce policy;
- cancellation increments the migration nonce and clears the pending intent.

Loom deliberately does not use chain-ID-less replayable migration in the core.
Cross-chain key and config updates can create account-linkage metadata and
require finality and proof assumptions that do not belong in the local account
until a separately reviewed L1-rooted protocol exists.

## Limited ERC-7579 module adapter

`ERC7579ModuleAdapter` provides the standard `onInstall(bytes)`,
`onUninstall(bytes)`, and `isModuleType(uint256)` lifecycle surface. Loom
module installation remains deliberately timelocked and explicit: callers
encode the lifecycle callback as the `initData` or `deInitData` passed to the
account. An adapter must also implement Loom's narrower validator, hook, or
recovery runtime interface.

This adapter does not make Loom a generally conformant ERC-7579 account.
Executor and fallback modules remain unsupported, `executeFromExecutor`
always reverts, and the single-call encoding remains Loom-specific.
