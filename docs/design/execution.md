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

## Direct validator requirements

Direct execution is an independent publication path, not an independent
authority layer. A validator is direct-capable only when it implements
`ILoomDirectValidator` and treats `validateDirectExecution` as a narrow
authorization profile for one exact account call.

A direct validator must:

- verify a signature or threshold over the account-provided direct execution
  digest, not over an application-defined digest;
- bind the exact account call supplied by `executeDirect`;
- enforce expiry and reject stale or malformed signatures;
- apply the same risk classification it would require for comparable
  EntryPoint execution;
- fail closed when required policy hooks, signer state, credential state, or
  validator configuration are missing;
- return `false` instead of reverting for ordinary invalid signatures whenever
  possible, so the account can preserve nonce rollback behavior;
- reject arbitrary ERC-1271 message signing unless that validator explicitly
  documents a narrower, reviewed ERC-1271 authority profile.

A direct validator must not:

- authorize calls by trusting `msg.sender`, `tx.origin`, the relayer, or a
  wallet frontend;
- read account policy during ERC-4337 `validateUserOp`; policy reads belong to
  execution-time hooks and direct-execution validation only;
- accept signatures that omit `configVersion`, nonce, chain ID, validator
  address, mode, calldata hash, or expiry from the account digest;
- grant session keys, guardians, paymasters, or relayers direct execution
  authority unless the account installed a validator specifically designed for
  that role;
- bypass freeze, hooks, policy accounting, unsupported-mode checks, or atomic
  execution by calling targets directly.

The account enforces the shared digest, nonce, freeze, hook, and execution
rules. Validators own only their signer-specific proof of authorization. This
keeps the EntryPoint liveness escape hatch compatible with Loom's narrow
authority and walkaway requirements.

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
- optional destination `configHash`;
- exact atomic call batch hash;
- current source `configVersion`;
- source migration nonce;
- execution delay and expiry;
- maximum 30-day execution window;
- current chain ID through `migrationIdFor`.

The account itself can schedule and cancel migrations through `execute`, so a
normal validator cannot silently bypass graded access. The guardian threshold
can also cancel the pending migration with `cancelMigrationWithGuardians`.
Guardians cannot execute the migration, change its destination, change its
calls, or move funds. Once ready, anyone can publish `executeMigration`; this
supports the walkaway test when the original wallet client, bundler, or
frontend is unavailable.

Execution remains conservative:

- migration cannot run while the account is frozen;
- primary-key self-cancellation cannot run while the account is frozen;
- migration cannot run before `readyAt`, after `expiresAt`, or after a source
  config change;
- migration windows longer than 30 days cannot be scheduled;
- destination code must match the commitment;
- Loom-compatible destinations can additionally bind destination `configHash`;
- the call batch must match the committed hash exactly;
- the batch is atomic;
- active hooks receive a synthetic batch `execute` call and can enforce policy;
- account or guardian-threshold cancellation increments the migration nonce
  and clears the pending intent.

`destinationConfigHash == bytes32(0)` is reserved for future standards that do
not expose Loom's `configHash()` interface, such as a future native account
model. This path is intentionally weaker than a Loom-to-Loom migration because
it commits only the destination runtime code hash. Wallets should prefer
non-zero destination config binding whenever the destination exposes a reviewed
configuration commitment.

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
