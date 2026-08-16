# ADR-0024: Asynchronous guardian approval without a second recovery authority

## Status

Proposed. Nothing is implemented. `RecoveryManager` is unchanged by this record
and remains the only contract that may replace an account's validator set.

## Problem

`RecoveryManager.proposeRecovery(...)` (`src/recovery/RecoveryManager.sol:56-124`)
takes the complete threshold approval array in one call. Guardians must therefore
approve *simultaneously in effect*: every approval has to reach one submitter
before anything touches the chain.

The passkey wallet implements exactly that. A guardian receives a request by
bearer link, QR, or file, reviews it in `RecoveryApprovalDialog`
(`examples/passkey-wallet-web/src/features/guardians/RecoveryApprovalDialog.tsx:32-52`),
signs, and hands a `RecoveryResponseV1` back over some channel the recovering
person then has to collect from
(`examples/passkey-wallet-web/src/features/recovery/RecoveryPage.tsx:455-470`).

Three consequences follow, and all three are user-visible failures rather than
theoretical ones:

1. A guardian cannot find out that an account they protect is being recovered.
   `GuardianWorkspace` can only react to a payload someone pastes into it
   (`examples/passkey-wallet-web/src/features/guardians/GuardianWorkspace.tsx:89-102`).
   A recovering user who has lost the device that held their guardians' contact
   details has no way to reach them, and the guardians have no way to notice.
2. Every guardian response must survive a round trip back to one coordinating
   device. If that device is the one that was lost, the collected approvals are
   lost with it and collection restarts.
3. The recovering person must be online and holding all responses at the moment
   of proposal. There is no way for guardians to approve over three days at their
   own convenience and have a stranger finalise the result.

Requirement: a guardian must be able to detect an active recovery for an account
they already hold a capability for, publish an approval on their own schedule,
and let any other party finalise — without any of that creating a new authority,
a mandatory service, or a guardian registry.

## Evidence

`GuardianVerificationLib.approved(root, threshold, digest, approvals)`
(`src/libraries/GuardianVerificationLib.sol:48-75`) already verifies an arbitrary
threshold against a root and fails closed on every malformed input. Called with
`threshold = 1` and a one-element array it is exactly a single-guardian approval
check, against the account's live root, with no new verification code.

`RecoveryManager.proposalDigest(...)` is `public view`
(`src/recovery/RecoveryManager.sol:186-210`) and its EIP-712 domain already binds
chain and the manager's own address (`_domainSeparator`, line 232-234). Any
contract can therefore obtain the exact digest a guardian must sign *from the
manager itself*, rather than reconstructing a signing domain that could drift.

`recoveryIdFor(...)` is `public pure` (line 171-184), so the same identity a
proposal will carry can be derived by a third party before the proposal exists.

`recoverConfiguration` is gated on the caller being an installed recovery module
(ADR-0016, `docs/decisions/0016-freeze-covers-recovery-path.md:42-46`). A contract
that is not installed as a recovery module on the account has no path to account
state at all, whatever it stores or emits.

The SDK has no log-reading surface: no `getLogs` appears anywhere in
`packages/sdk/src`. Discovery is new capability, not a rewiring of existing code.

### Industry comparison

Asynchronous on-chain approval accumulation is not novel; the authority model is
where the designs diverge.

- ERC-7093 (Draft, 2023-05-29) requires the batch:
  `startRecovery(uint256 configIndex, bytes newOwner, Permission[] permissions)`.
  Same constraint as Loom today.
- OpenZeppelin `ERC7579Multisig` / `ERC7579MultisigStorage` /
  `ERC7579DelayedExecutor` validate a submitted signature package; accumulation
  happens inside modules that are installed as executors.
- Candide `SocialRecoveryModule` accumulates asynchronously —
  `confirmRecovery(address _wallet, address[] _newOwners, uint256 _newThreshold, bool _execute)`
  writing `confirmedHashes[recoveryHash][guardian]` — but the accumulating module
  is itself the contract that later rewrites the wallet's owners.
- zkEmail `EmailRecoveryManager` accumulates via `acceptGuardian` /
  `processRecovery`, again inside the contract that performs recovery.
- Safe's ERC-7579 adapter leans on the Rhinestone registry, which "automatically
  disables" modules judged compromised. That is a mandatory external trust anchor,
  which `ARCHITECTURE.md:17-19` excludes.

No reviewed design separates *accumulation* from *authority*. That separation is
what this record proposes, and it is the only reason a new contract is needed.

## Options

### A. Extend `RecoveryManager` with announcement and per-guardian approval

Rejected. `RecoveryManager` is immutable and deployed. Adding state changes
`storage-layout.json` and produces a manager that existing accounts cannot adopt
without a fresh account, because the installed module address is committed in
account configuration. It also widens the audit surface of the one contract that
holds recovery authority, in exchange for a coordination convenience.

### B. An optional module that collects approvals and performs the recovery

Rejected in the form usually shipped. A module that both accumulates approvals
and calls `recoverConfiguration` must be installed as a recovery module, and
`RecoveryManager` permits only one installed recovery module per account
(`docs/design/recovery.md:40-41`). Adopting such a board would mean *replacing*
the audited manager with a larger, newer contract as the account's sole recovery
authority. That is the Candide and zkEmail shape, and it inverts the intent: the
convenience layer becomes the thing holding the keys.

### C. Verification and publication only, authority unchanged

Selected. A contract may verify a single guardian approval against the account's
live root and emit it. It never becomes an installed module, never calls the
account, and never holds recovery state. Reassembly happens off-chain; the final
authoritative check stays in `proposeRecovery`, unmodified.

The first draft of option C carried a per-`recoveryId` approval counter so a
client could read "3 of 5" with one `eth_call`. It was removed. The counter buys
nothing: duplicate approvals are already rejected by
`GuardianVerificationLib.approved`'s strictly-increasing-leaf and unique
key-commitment rules at propose time, and the "last guardian submits the whole
bundle" case is served by the existing `proposeRecovery`, which anyone may call.
What the counter cost was a permissionless mapping write — the one component of
this design capable of unbounded state growth. Removing it leaves a contract with
**zero storage variables**, which removes the entire state-griefing class rather
than bounding it.

## Decision

Add `RecoveryIntentBoard`: immutable, ownerless, no storage, no account
authority, and optional per deployment. It has two external functions.

**`announce(...)` — unverified, event only.**

Emits `RecoveryAnnounced(address indexed account, bytes32 indexed recoveryId, …)`
and writes nothing. Anyone may call it. It is unverified *by construction*, and
clients must render it as such.

This is safe precisely because it is inert. It cannot occupy a recovery slot,
because slots live in `pendingRecoveries` on the manager and this contract cannot
write there. It cannot reset or extend a delay, cancel, replace, or block a
legitimate request, because it holds no state that any of those read. It cannot
make the account pay gas. Unlimited announcements cost the announcer full
transaction gas and produce log noise a guardian's client discards, because that
client filters to accounts it holds a capability for and re-derives `recoveryId`
from live account state before showing anything as verified.

An attacker *can* announce a well-formed request naming a validator they control.
That is not a new threat: it is the same act as handing a guardian a malicious
request over any channel today, and it goes nowhere without threshold approvals.
The existing six-digit comparison code
(`packages/sdk/src/recoveryProtocol.ts:117-120`) remains the out-of-band defence.

**`publishApproval(...)` — verified, event only.**

Reads `configVersion` from the account and `recoveryNonces(account)` from the
manager, so freshness is taken from chain state and never from the caller. Obtains
the digest by calling `recoveryManager.proposalDigest(...)`, so the signing domain
is the manager's, not this contract's. Requires
`GuardianVerificationLib.approved(account.guardianRoot(), 1, digest, [approval])`.
Emits `RecoveryApprovalPublished` carrying the full approval tuple in log data,
indexed by `account`, `recoveryId`, and guardian leaf.

A caller who is not a guardian under the account's live root cannot emit this
event at all, so the approval log is self-authenticating: a client may still
re-verify, and must, but a forged entry cannot be produced.

**No third function.** `approveAndPropose` was considered and dropped: a guardian
who wants to finalise calls the existing permissionless `proposeRecovery` with the
bundle, and routing that through this contract would add code without adding
capability.

### Why this is not a new authority

The board is not installed as a module, so `_isModuleInstalled(RECOVERY, board)`
is false and `recoverConfiguration` reverts for it. It cannot cancel:
cancellation requires either the account itself plus guardian support
(ADR-0023) or the full guardian threshold, and the board is neither the
account nor a guardian. It holds no state, so there is nothing for it to
withhold or corrupt. Deleting the contract from a deployment profile removes a
discovery channel and changes nothing else: every existing path — QR, file,
clipboard, bearer link, direct `proposeRecovery` — works unmodified.

Critically, the board is **not bound into the approval signature**. A guardian
signs the manager's `proposalDigest`, which contains no reference to any board.
An approval published on one board is equally valid off-chain, on a different
board, or in a bundle assembled by hand. This is deliberate and is why the
canonical `RecoveryRequestV1` format is **not** changed to carry a board address:
binding a discovery channel into the request would make an optional convenience
look like part of the security envelope. The board address travels in the
deployment profile, alongside `recoveryModule` and
`recoveryValidatorProvisioner`, and a client that does not recognise one simply
has no on-chain discovery.

### Spam and griefing policy

Stated explicitly, as required by `ARCHITECTURE.md:64-74`.

| Vector | Outcome |
|---|---|
| Announcement flood | Attacker pays gas per announcement. No storage, no authoritative state. Clients filter by locally held capability and discard anything failing live re-derivation. |
| Occupying the recovery slot | Impossible. The only slot is `pendingRecoveries[account]`, written solely by `proposeRecovery`, which still requires the full threshold. |
| Resetting or extending the delay | Impossible. `readyAt` is set only by `proposeRecovery`. |
| Blocking a legitimate request | Impossible. The board holds no state a legitimate request reads. |
| Forged approval | Impossible. `publishApproval` requires a real guardian under the live root. |
| Duplicate approval | Rejected twice: identical leaves are deduplicated by clients at reassembly, and rejected by `GuardianVerificationLib.approved` at propose time. |
| Unbounded storage growth | Structurally impossible. Zero storage variables, enforced by `tools/quality/validate-no-storage-writes.mjs`, which rejects the deployed bytecode if it contains `SSTORE` or `TSTORE`, and by a `vm.record()` check over both entry points. Note that `storage:check` does *not* enforce this: it permits appending, so a first slot would pass it. |
| Forged digest source | `publishApproval` and `announce` require the named manager to be the account's own installed recovery module, so the digest cannot come from a contract the caller chose. Without this a post could carry a genuine recovery identity while its approval was verified against an attacker's digest. |
| Making the account pay gas | Impossible. The board never calls the account. |
| Learning the guardian graph | A guardian is revealed only by their own act of publishing. Dormant guardians remain invisible; the board enumerates nothing. |
| Cancelling or replacing an approved request | Impossible. No cancellation surface exists. |

The residual griefing cost is log noise, which is bounded by the griefer's gas
budget and is filtered client-side. No mitigation is placed in account authority.

### Privacy consequence, and the resulting default

This is the significant cost of the change and it is not a detail.

Today a guardian's verifier, key commitment, salt, proof, and signature become
public only when `proposeRecovery` succeeds — and `recoverConfiguration` rotates
to a fresh guardian root in the same transaction, so disclosure is atomic with the
retirement of the disclosed tree (`docs/design/recovery.md:52-56`).

`publishApproval` breaks that coupling. A guardian who publishes on-chain and then
sees the recovery abandoned, cancelled, or expired has revealed themselves against
a root that is **still live**. They remain in the tree, now permanently linked to
that account, and are a known target for coercion or a targeted attack ahead of
any future recovery. Nothing rotates to repair this.

Therefore:

- "Sign only and share privately" remains the **default** guardian action.
- "Approve and publish on-chain" is an explicit secondary choice, never
  preselected, and its review must state that publishing is irreversible and that
  the guardian stays exposed if the recovery does not complete.
- The two produce byte-identical approvals over the same digest, so choosing
  privacy costs the guardian no interoperability.

### Acceptance condition

- A guardian holding only a capability and an RPC endpoint discovers an active
  recovery for that account through a bounded log query, with no indexer, relay,
  or mailbox.
- Two guardians publish approvals in separate transactions, hours apart, and an
  unrelated third party assembles both from logs and proposes successfully.
- A non-guardian's `publishApproval` reverts; an unlimited announcement flood
  leaves `pendingRecoveries`, `recoveryNonces`, and every account field unchanged.
- Deleting the board from the deployment profile leaves every existing recovery
  path passing its current tests unmodified.
- A mutation removing the `threshold = 1` guardian check in `publishApproval`
  fails a test.

### Change classification

Additive at the contract layer: one new contract, no change to `RecoveryManager`,
`LoomAccount`, `GuardianVerificationLib`, `storage-layout.json`, or any existing
ABI. Additive at the SDK layer: new log-query and discovery surface. Additive at
the wire layer: `RecoveryRequestV1` and `RecoveryResponseV1` are unchanged, so
requests and approvals already in flight stay valid. Deployment profiles gain one
optional field; a profile omitting it is valid and yields a wallet with no
on-chain discovery.

## Residual risks

The board is unaudited and pre-audit, like the rest of the repository. It is
optional, which bounds the blast radius to clients that opt in, but a bug in
`publishApproval` that accepted a non-guardian would emit misleading logs. That is
survivable only because `proposeRecovery` re-verifies every approval
independently; no client may treat a board log as sufficient, and the SDK must
re-verify each reassembled approval before submission. This is a design
assumption, not something the contract enforces on its consumers.

Log-only accumulation makes clients reorg-sensitive in a way `eth_call` reads are
not. A displayed approval count can decrease. Handling this correctly — rolling
the count back and never treating a reorged approval as progress — is client work
that a storage counter would have avoided. The trade was accepted to eliminate
permissionless state growth, and it must be tested rather than assumed.

Bounded log queries assume an RPC that serves `eth_getLogs` over a useful range.
Public endpoints impose limits that vary by provider. Discovery therefore has a
liveness dependency that the manual QR, file, and clipboard paths do not, which is
why those paths remain first-class and must not be removed or demoted.

The privacy regression above is real and is not fully mitigated by defaults. A
guardian can be socially pressured into publishing on-chain. The only structural
repair would be rotating the guardian root on a failed recovery, which would hand
any single guardian a denial-of-service against the set, and is rejected for the
same reason ADR-0016 rejects re-arming freezes.

`announce` publishes the account address, intended new validator, new guardian
root, and expiry before any guardian has agreed. `RecoveryProposed` already
publishes the same fields, but only once the threshold is met. Announcing
therefore discloses an *attempted* recovery that may never have been legitimate,
including one an attacker announced. Announcement is optional per recovery and the
wallet must not perform it silently.

Whether guardians will actually accept the on-chain publication cost, and whether
the discovery UX measurably reduces failed recoveries, is unmeasured. This record
argues the authority model is safe. It does not claim the feature is wanted.
