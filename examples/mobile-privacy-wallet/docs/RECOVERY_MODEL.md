# Recovery Model

Recovery is part of self-sovereignty, not an onboarding tax. This example uses
**progressive recovery**: an account can be created with a passkey and no
guardians, but the UI must show it as `unprotected-recovery` until guardians are
configured.

## Modes

**Consumer mode (default in this example)**
- Minimal onboarding: passkey only.
- Recovery deferred; the account reports `unprotected-recovery`.
- The app shows a persistent prompt to configure guardians.

**Organization mode (documented, not wired here)**
- A preconfigured guardian root supplied by the organization at creation.
- Policy-controlled recovery with admin/compliance documentation.
- Requires the enterprise integration path; out of scope for this boilerplate.

## Loom recovery properties (enforced by the contracts)

- Threshold guardians approve a validator-set replacement.
- Visible delay, an execution window, and cancellation.
- Guardians gain **no spending authority** — recovery replaces authority, it does
  not move funds.
- A single guardian can trigger an emergency freeze without being able to spend.

## Scenarios

| Scenario | Outcome |
| --- | --- |
| Lost phone | New device + passkey; guardian recovery replaces the validator on chain. |
| Lost passkey | Same as lost phone: guardians recover; without guardians the account is unrecoverable (this is the consumer-mode tradeoff, shown honestly). |
| Malicious guardian | Cannot spend; recovery is timelocked and cancellable by the account. |
| Client shutdown | Another compatible client controls the same account; recovery state lives on chain, not in this app. |
| Migration | Sovereign migration moves authority to a new destination with a committed code/config hash and a delay. |

## Gap

The mobile guardian ceremony (proof-of-possession, encrypted backup, usability
and privacy evidence) is not production-verified here — see `GAPS.md` G-004.
Guardian setup is blocked until that evidence is supplied.
