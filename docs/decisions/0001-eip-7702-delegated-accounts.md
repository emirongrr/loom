# EIP-7702 delegated accounts

Status: accepted
Date: 2026-06-16

## Problem

EOA users should be able to adopt Loom without moving assets or changing
addresses. EIP-7702 enables this by letting the EOA delegate execution to
reviewed account code, but it also creates a persistent authorization risk.

## Evidence

EIP-7702 writes a persistent delegation indicator to the EOA and does not run
initcode. Initialization must therefore be a normal call after delegation.
The EIP also warns that applications must not ask users to sign arbitrary
authorizations because delegated code has unrestricted access to the account.

## Options

- Reuse `LoomAccount` runtime with a one-time delegated initializer. This keeps
  one account logic surface and preserves existing Loom authorization rules.
- Create a separate copied 7702 account implementation. This reduces coupling
  but duplicates security-critical account logic.
- Do not support 7702. This avoids delegation risk but blocks address-preserving
  adoption for existing EOA users.

## Decision

Add `initializeDelegatedAccount(...)` to `LoomAccount`. The function is valid
only when called by the delegated account itself and only while `configVersion`
is zero. Constructor-deployed accounts start at version one and cannot use it.

Acceptance requires tests proving external initialization fails,
self-initialization succeeds on delegated runtime storage, normal constructor
accounts cannot be reinitialized, and initialized delegated accounts can use
Loom direct execution.

## Residual risks

7702 authorization UX remains high risk. Users must verify the delegated
template address, runtime bytecode, EntryPoint binding, and chain before
signing. Browser and wallet clients must clearly distinguish one-time
transaction signatures from persistent code-delegation authorizations.
