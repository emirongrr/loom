# ADR 0016: Guardian identity discovery

## Status

Accepted. Guardian identity discovery is an application/SDK responsibility;
the selected verifier is explicit and immutable in the on-chain guardian leaf.

## Context

Asking a user to decide whether an address is an EOA, a smart-contract wallet,
or a Loom passkey wallet creates a predictable authority-configuration error.
Counterfactual accounts have no runtime code before deployment, so automatic
classification cannot safely support them until they are deployed.

ERC-7093 proposes a social-recovery identity model and discusses address-backed
EOA and smart-contract guardians. It remains Draft. ERC-1271 is Final and
defines the contract-signature validation primitive. ERC-7579 standardizes
modular account and validator interfaces, but does not standardize guardian
discovery. Loom does not claim ERC-7093 conformance.

Loom additionally commits each guardian verifier's runtime code hash and a
salted key commitment in a private Merkle set. Treating a Loom account address
as a mutable ERC-1271 authority would silently change the guardian when that
account rotates its validator. The current direct P-256 resolution instead pins
the exact active key selected by the protected account owner.

## Decision

The wallet accepts one guardian address and never asks the user to select an
account type. For deployments that publish separate legacy verifiers, it:

1. checks the deployment's Loom account registry first and resolves a registered
   Loom account to one trusted active P-256 key;
2. probes the ERC-1271 signature interface of any other address with runtime
   code, classifies it as ERC-1271, and presents a warning when the invalid-
   signature probe is inconclusive;
3. classifies an address without runtime code as ECDSA.

The resulting explicit verifier and verifier code hash remain committed in the
guardian leaf. Detection is setup-time compatibility logic, not a claim that
runtime code alone proves ERC-1271 support. Counterfactual smart accounts must
be deployed before they can be configured through this compatibility path.

There is no unified on-chain account verifier. The selected ECDSA, ERC-1271, or
P-256 verifier is part of the Merkle leaf together with its runtime code hash.
Approval-time verification therefore cannot reclassify the guardian because
the address later gains, loses, or changes runtime code. Dedicated P-256
guardians remain verifier-backed non-account identities.

Acceptance requires tests proving registry-first classification, EOA and
verified deployed-contract classification, a visible warning when ERC-1271
support is inconclusive, rejection of a contract that accepts the deliberately
invalid probe, invalid-address rejection, and unchanged P-256 fail-closed
resolution.

## Residual risks

- ERC-1271 does not standardize interface discovery. A compatible contract that
  reverts for every invalid signature probe is rejected as inconclusive and
  needs an explicitly reviewed integration profile before it can be admitted.
- An undeployed counterfactual contract cannot be configured automatically.
- RPC or registry failure blocks addition rather than guessing the authority.
- If an EOA later becomes a contract, or contract code changes, its existing
  leaf remains bound to the originally selected verifier until explicitly
  rotated through the guardian-change timelock.

## Standards references

- ERC-7093: https://eips.ethereum.org/EIPS/eip-7093
- ERC-1271: https://eips.ethereum.org/EIPS/eip-1271
- ERC-7579: https://eips.ethereum.org/EIPS/eip-7579
- ERC-6900: https://eips.ethereum.org/EIPS/eip-6900
