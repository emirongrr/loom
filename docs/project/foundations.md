# Design Foundations

Loom's constitution translates a set of wallet, privacy, recovery,
cross-chain, zero-knowledge, formal-method, and engineering ideas into binding
project decisions. These sources inform Loom; they do not replace Loom's own
threat model or evidence requirements.

## Wallets As Sovereign Infrastructure

Wallets should combine high everyday usability with security, privacy, and
provider-independent operation. Private transfers, application-separated
accounts, light-client verification, and local ownership of the global user
view are wallet responsibilities rather than optional specialist features.

Loom consequence: the account core remains independently operable, while the
future client must make privacy and verification ordinary user experiences.

Source: https://vitalik.eth.limo/general/2024/12/03/wallets.html

## Recovery Without A Single Point Of Failure

Security should avoid both theft by one compromised object and permanent loss
from one missing object. Recovery must keep normal transactions easy while
distributing exceptional authority.

Loom consequence: passkey-first operation, threshold guardians, visible delay,
cancellation, expiry, freeze, and no guardian spending authority.

Source: https://vitalik.eth.limo/general/2021/01/11/recovery.html

## Tools, Not Empires

Permissionless participation, decentralization, censorship resistance,
auditability, credible neutrality, interoperability, and positive-sum
cooperation are product requirements.

Loom consequence: integrations may improve convenience, but no provider,
institution, registry, or Loom-operated service becomes mandatory authority.

Source: https://vitalik.eth.limo/general/2023/12/28/cypherpunk.html

## Trustless Cross-Chain Authority

Many accounts across L1 and L2 require key changes that do not depend on
insecure bridges or repeated manual updates. Cross-chain proofs must account
for state roots, finality, latency, reorgs, aggregation, and privacy.

Loom consequence: Ethereum L1 is the intended future trust root; cross-chain
configuration remains disabled until a proof protocol is independently
specified and audited. Related accounts must not become publicly linkable.

Source: https://vitalik.eth.limo/general/2023/06/20/deeperdive.html

## Least-Disclosure Identity

Zero-knowledge identity can reduce disclosure but does not automatically
preserve pseudonymity, resist coercion, prevent issuer capture, or handle
errors. Pluralistic identity and multiple accounts remain necessary.

Loom consequence: no mandatory global identity, no one-person-one-account
assumption, and no identity provider as account authority.

Source: https://vitalik.eth.limo/general/2025/06/28/zkid.html

## Zero-Knowledge Systems

Zero-knowledge proofs can establish a statement without revealing its witness,
but real systems still depend on the statement, circuit, verifier, setup,
prover availability, implementation, and surrounding metadata.

Loom consequence: every proof integration must state exactly what is proven,
what is revealed, who can block operation, and which assumptions remain.

Sources:

- https://vitalik.eth.limo/general/2022/06/15/using_snarks.html
- https://vitalik.eth.limo/general/2021/01/26/snarks.html

## Redundant Expressions Of Intent

Tests, types, formal specifications, symbolic execution, and human-readable
requirements are independent ways to express intent. Agreement between them
increases confidence, but none proves that software fully matches human
expectations.

Loom consequence: formal claims are narrow and assumption-aware; audit,
testing, fuzzing, invariants, static analysis, and operational evidence remain
necessary.

Source: https://vitalik.eth.limo/general/2026/05/18/fv.html

## Engineering Discipline

Engineering begins with observation and measurement, advances through short
feedback loops and small vertical slices, prefers simplicity, generalizes
late, dogfoods its tools, and adds process when it exposes real risk.

Loom consequence: experiments reduce uncertainty outside production authority;
production changes remain small, measured, reviewable, and evidence-backed.

