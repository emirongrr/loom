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
monotonic direct nonce, current `configVersion`, and expiry. Direct execution
then enters the same `execute` authorization body, freeze checks, hooks, policy
accounting, and atomic execution behavior as EntryPoint execution. Session
validators deliberately do not implement the direct-validator interface.

Hooks receive the external transaction publisher as `caller` on the direct
path. A hook must treat this value as transport context, not account authority;
authorization comes from the direct validator and signed digest.

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
