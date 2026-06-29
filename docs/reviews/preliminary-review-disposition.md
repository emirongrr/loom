# Preliminary Review Disposition

This document records the disposition of the preliminary manual review
provided before audit. It is not an audit report.

| Finding | Disposition |
|---|---|
| HIGH-01 Policy destination restrictions | Fixed for standard ERC-20 calls with optional exact recipient/spender binding. Rich allowlists remain future audited work. |
| HIGH-02 WebAuthn user-supplied offsets | Fixed by removing signer-supplied offsets and requiring Loom's exact canonical same-origin `clientDataJSON` encoding. Browser compatibility remains release-test scope. |
| HIGH-03 Session `policyRoot` naming | Fixed: renamed to `callHash`; the exact-call session intentionally authorizes one complete account call. |
| HIGH-04 Immediate session grants | Fixed: grants require scheduled config execution and advance `configVersion`; revocation remains immediate. |
| HIGH-05 Guardian ERC-1271 scope | Fixed by removing the general guardian validator. Guardians now have only emergency freeze and visible delayed recovery authority. |
| MEDIUM-01 P-256 malleability | Fixed: zero and high-s signatures are rejected before precompile or fallback verification. |
| MEDIUM-02 Hook denial of service | Mitigated two ways: a narrow bypass that can schedule and execute the 72-hour delayed removal of an installed hook (every other normal and scheduled execution uses the pre-check hook snapshot), and `evictHookWithGuardians` (decision 0005), which lets the guardian threshold uninstall a stuck hook immediately with no delay. The 72-hour exposure window now only applies when no guardian threshold is reachable; residual risk is scoped to guardian-threshold availability, not a fixed delay. |
| MEDIUM-03 Module initialization external calls | Mitigated by constructor semantics and execution reentrancy guard; a regression test confirms scheduled reentrant initialization rolls back without changing config. Retained in audit scope. |
| MEDIUM-04 Malformed validator signatures | Account validation and ERC-1271 boundaries catch validator reverts and fail closed. Direct module calls are not trusted authorization boundaries. |
| MEDIUM-05 Hook validation during init | Constructor-time account code is unavailable. Primary validation rejects a hook unless it is installed on the account. |
| LOW-01 ECDSA policy-hook events | Fixed with `PolicyHookSet`. |
| LOW-02 Unbounded guardian proofs | Fixed with a maximum proof length of 32. |
| LOW-03 Minimal EntryPoint validation | Hardened by checking EntryPoint and SenderCreator code. Official bytecode verification remains a deployment gate. |
