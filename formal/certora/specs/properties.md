# Loom Certora Properties

These properties follow the same layered evidence policy as the rest of Loom:
CVL rules are formal specifications for selected behaviors, not proof of all
wallet behavior.

## Valid State Properties

- Validator count must remain non-zero.
- Guardian threshold and root changes must preserve valid guardian config.

## Variable Transition Properties

- `configVersion` must never decrease.
- Failed direct privileged calls must preserve account authority state.

## Authority Boundary Properties

- Direct external callers cannot set guardian configuration.
- Direct external callers cannot execute recovery.
- Non-self callers cannot install modules, uninstall modules, schedule calls,
  cancel scheduled calls, or unfreeze the account.
- Uninstalling a validator cannot leave the account with zero validators.

## Initialization and Upgrade-Surface Properties

- Initialized accounts cannot be initialized again.
- Delegated account initialization must reject direct external callers.
- Account upgrade/admin selector checks are covered in Foundry/Halmos until a
  dedicated Certora method-selector harness is added.

## Planned Rule Groups

- Recovery proposal delay, expiry, cancellation, and complete-set replacement.
- Migration destination/config/call-hash binding.
- Immutable proxy implementation immutability.
- Registry and factory non-authority.
- Vault delay and guardian cancellation without spending authority.

## Claim Boundary

These rules require reviewed summaries for validators, hooks, recovery modules,
EntryPoint behavior, ERC-20 behavior, and environment time before they can be
treated as audit-candidate evidence.
