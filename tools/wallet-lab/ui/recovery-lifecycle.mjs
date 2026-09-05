const RECOVERY_NODES = Object.freeze([
  {
    id: "provision",
    layer: "validator-factory",
    actor: "Recovering device",
    contract: "P256RecoveryValidatorFactory",
    function: "deploy",
    title: "Deploy and initialize the new passkey validator",
    summary: "CREATE2 binds the validator address to the account, recovery nonce, passkey initialization hash, and complete rotated guardian set.",
    state: "A deterministic P256RecoveryValidator already initialized with the new passkey exists before guardian approval collection begins.",
    invariant: "The ownerless factory cannot redirect the reservation, and a different guardian root or threshold produces a different address."
  },
  {
    id: "digest",
    layer: "recovery-module",
    actor: "Recovery client",
    contract: "RecoveryManager",
    function: "proposalDigest",
    title: "Bind the complete recovery intent",
    summary: "The EIP-712 digest binds the account, complete old validator set, new validator, init-data hash, fresh guardian root, config version, nonce, chain, and manager.",
    state: "No on-chain state changes; guardians receive one exact intent to review.",
    invariant: "Changing any authority-bearing field invalidates every collected approval."
  },
  {
    id: "announce",
    layer: "optional-discovery",
    actor: "Any publisher",
    contract: "RecoveryIntentBoard",
    function: "announce",
    title: "Optionally announce the intent",
    summary: "The board checks the account's installed RecoveryManager, reads live config and nonce, then emits a discovery hint. It writes no storage.",
    state: "RecoveryAnnounced is a log only; no pending recovery, delay, nonce, account field, or authority changes.",
    invariant: "The announcement is unverified and optional; clients must re-derive the recovery ID and preserve private request sharing."
  },
  {
    id: "approve",
    layer: "guardian-verifier",
    actor: "Guardian threshold",
    contract: "Guardian verifiers",
    function: "verify",
    title: "Verify independent guardian approvals",
    summary: "Sorted Merkle proofs bind each guardian verifier, verifier code hash, key commitment, and salt to the current guardian root.",
    state: "Approvals remain portable evidence until proposal submission; they grant no spending authority.",
    invariant: "Duplicate leaves, duplicate commitments, invalid proofs, and verifier failures reject the proposal."
  },
  {
    id: "publish-approval",
    layer: "optional-discovery",
    actor: "One guardian",
    contract: "RecoveryIntentBoard",
    function: "publishApproval",
    title: "Optionally publish one approval",
    summary: "The board reads the manager's exact digest, verifies one live guardian at threshold one, and emits the portable approval tuple for later collection.",
    state: "RecoveryApprovalPublished adds a public log but no approval counter, pending recovery, or account state.",
    invariant: "Publishing irreversibly reveals that guardian if recovery is abandoned; private sharing remains the default and RecoveryManager re-verifies everything."
  },
  {
    id: "assemble",
    layer: "client-coordination",
    actor: "Any independent client",
    contract: "Off-chain client",
    function: "bounded log scan + local verification",
    title: "Assemble a portable threshold bundle",
    summary: "A client combines private responses and optional board logs, removes duplicates, handles reorg rollback, and independently verifies each candidate.",
    state: "No authority changes; the resulting sorted approval array can be carried to any publisher.",
    invariant: "The board and RPC are discovery hints, not sources of truth; manual QR, file, and clipboard paths remain sufficient."
  },
  {
    id: "propose",
    layer: "recovery-module",
    actor: "Any publisher",
    contract: "RecoveryManager",
    function: "proposeRecovery",
    title: "Publish one pending recovery",
    summary: "Anyone may pay gas to publish the threshold-approved commitment. The publisher receives no wallet authority.",
    state: "pendingRecoveries[account] is written and RecoveryProposed exposes readyAt and expiresAt.",
    invariant: "Only one pending recovery exists; the installed recovery module and complete old validator set are checked."
  },
  {
    id: "delay",
    layer: "recovery-module",
    actor: "On-chain clock",
    contract: "RecoveryManager",
    function: "RECOVERY_DELAY / RECOVERY_WINDOW",
    title: "Wait 3 days; expose a 7-day execution window",
    summary: "The visible delay gives the current account and guardians time to detect and contest a malicious proposal.",
    state: "Execution rejects before readyAt and after expiresAt.",
    invariant: "The account config version must remain the version approved by guardians."
  },
  {
    id: "execute",
    layer: "recovery-module",
    actor: "Any publisher",
    contract: "RecoveryManager",
    function: "executeRecovery",
    title: "Re-check and consume the pending recovery",
    summary: "The module re-hashes oldValidators, checks the delay, expiry, and approved config version, then consumes the pending record before calling the account. No initializer is supplied at execution.",
    state: "The pending recovery is deleted and recoveryNonces[account] advances before the atomic account call.",
    invariant: "A revert in the account call rolls the deletion and nonce update back with the whole transaction."
  },
  {
    id: "core-handoff",
    layer: "module-boundary",
    actor: "Installed recovery module",
    contract: "RecoveryManager → LoomAccount",
    function: "recoverConfiguration",
    title: "Send the exact authority payload to account core",
    summary: "RecoveryManager can call only the account's narrow recovery entry point; it does not receive execute, transfer, hook, or arbitrary-call authority.",
    payload: ["oldValidators[]", "newValidator", "initData = 0x (already initialized)", "newGuardianRoot", "newGuardianThreshold"],
    state: "One typed call crosses from the installed recovery module into LoomAccount core.",
    invariant: "The account independently requires msg.sender to be an installed recovery module."
  },
  {
    id: "core-apply",
    layer: "account-core",
    actor: "LoomAccount core",
    contract: "LoomAccount",
    function: "recoverConfiguration",
    title: "Atomically rotate account authority",
    summary: "Core validates the complete old validator set, the new validator contract and module type, and the fresh guardian configuration before changing state.",
    state: "Old validators are removed, the already-initialized validator is installed, guardian root and threshold rotate, and config version advances atomically.",
    invariant: "Recovery cannot transfer funds or call arbitrary targets; any invalid module or initialization reverts every authority change."
  },
  {
    id: "publish-cancellation",
    layer: "optional-discovery",
    actor: "One guardian",
    contract: "RecoveryIntentBoard",
    function: "publishCancellation",
    title: "Optionally publish one cancellation approval",
    summary: "The board reads the actual pending recovery, verifies one guardian's cancellation digest, and emits a separate cancellation event for quorum assembly.",
    state: "The recovery remains pending until someone submits a valid cancellation bundle to RecoveryManager.",
    invariant: "This is an event only, cannot be confused with a proposal approval, and gives the board no cancellation authority."
  },
  {
    id: "cancel-account",
    layer: "recovery-module",
    actor: "Current account + guardian support",
    contract: "RecoveryManager",
    function: "cancelRecoveryWithAccountAndGuardians",
    title: "Cancel with account and reduced guardian threshold",
    summary: "The account may cancel only with guardian support; a compromised current validator cannot veto recovery alone.",
    state: "Pending recovery is deleted and its nonce advances.",
    invariant: "For thresholds above one, exactly one fewer guardian approval is sufficient; the caller must be the account."
  },
  {
    id: "cancel-guardians",
    layer: "recovery-module",
    actor: "Full guardian threshold",
    contract: "RecoveryManager",
    function: "cancelRecoveryWithGuardians",
    title: "Cancel without current account authority",
    summary: "Guardians can reject a malicious or obsolete proposal even when the current validator is unavailable.",
    state: "Pending recovery is deleted and its nonce advances.",
    invariant: "The full current guardian threshold must approve the cancellation digest."
  }
]);

const RECOVERY_EDGES = Object.freeze([
  ["provision", "digest", "validator + initDataHash"],
  ["digest", "approve", "private request (default)"],
  ["digest", "announce", "optional discovery log"],
  ["announce", "approve", "unverified hint; verify independently"],
  ["approve", "assemble", "private approval (default)"],
  ["approve", "publish-approval", "optional public approval"],
  ["publish-approval", "assemble", "log + independent re-verification"],
  ["assemble", "propose", "sorted threshold bundle"],
  ["propose", "delay", "RecoveryProposed"],
  ["delay", "execute", "account + oldValidators[]"],
  ["execute", "core-handoff", "verified committed payload"],
  ["core-handoff", "core-apply", "recoverConfiguration(...)"],
  ["delay", "cancel-account", "contest path"],
  ["delay", "cancel-guardians", "guardian veto"],
  ["delay", "publish-cancellation", "optional asynchronous objection"],
  ["publish-cancellation", "cancel-account", "reduced quorum bundle"],
  ["publish-cancellation", "cancel-guardians", "full quorum bundle"],
  ["cancel-account", "propose", "new nonce; restart only"],
  ["cancel-guardians", "propose", "new nonce; restart only"]
].map(([from, to, label]) => ({ from, to, label })));

const FREEZE_NODES = Object.freeze([
  {
    id: "freeze-digest",
    layer: "guardian-client",
    actor: "Guardian client",
    contract: "LoomAccount",
    function: "guardianLeaf / FREEZE_TYPEHASH",
    title: "Bind one configured guardian",
    summary: "The digest binds the guardian leaf, that leaf's freeze nonce, and the current account config version.",
    state: "No state changes before proof and signature verification.",
    invariant: "A capability copied from another account, config version, or guardian leaf cannot be replayed."
  },
  {
    id: "freeze-submit",
    layer: "account-core",
    actor: "Any publisher",
    contract: "LoomAccount",
    function: "freeze",
    title: "Submit the guardian capability to account core",
    summary: "The publisher pays gas and supplies the verifier-specific capability directly to LoomAccount; RecoveryManager is not in the freeze call path.",
    payload: ["verifier", "keyCommitment", "salt", "proof[]", "signature"],
    state: "No authority changes until every account-side proof and signature check succeeds.",
    invariant: "Publishing a capability grants the publisher no spending, recovery, or cancellation authority."
  },
  {
    id: "freeze-membership",
    layer: "account-core",
    actor: "LoomAccount core",
    contract: "LoomAccount",
    function: "guardianLeaf / MerkleProof.verify",
    title: "Bind membership, nonce, and config version",
    summary: "Core reconstructs the leaf from verifier codehash, key commitment, and salt, proves it under guardianRoot, then builds the freeze digest.",
    state: "The leaf must be unused for the current config version and its proof must be at most the configured bound.",
    invariant: "A capability from another account, verifier bytecode, leaf, nonce, or config version cannot be replayed."
  },
  {
    id: "freeze-verify",
    layer: "guardian-verifier",
    actor: "One guardian",
    contract: "ECDSA / P256 / ERC1271 verifier",
    function: "verify",
    title: "Verify proof and signature",
    summary: "A Merkle proof establishes membership in the current guardian root; the selected verifier checks the guardian's native signature format.",
    state: "Verifier calls are read-only and convey no spending permission.",
    invariant: "The verifier address and its runtime code hash are committed inside the guardian leaf."
  },
  {
    id: "freeze-write",
    layer: "account-core",
    actor: "Any publisher",
    contract: "LoomAccount",
    function: "freeze",
    title: "Open the 5-day emergency window",
    summary: "The caller pays gas; the verified guardian capability extends frozenUntil and cannot shorten an existing freeze.",
    state: "freeze nonce and last-used config version advance; Frozen(frozenUntil) is emitted.",
    invariant: "Each guardian leaf can freeze only once per account config version."
  },
  {
    id: "freeze-block",
    layer: "account-core",
    actor: "LoomAccount execution boundary",
    contract: "LoomAccount",
    function: "_isFrozenSafe",
    title: "Block ordinary account execution",
    summary: "Normal single and batch calls fail while the emergency window is active.",
    state: "Funds do not move and ordinary validator-authorized calls revert with AccountFrozen.",
    invariant: "Freeze is a veto only; it never becomes execution, spending, or recovery approval authority."
  },
  {
    id: "freeze-escape",
    layer: "recovery-module",
    actor: "Account + guardian support",
    contract: "RecoveryManager",
    function: "cancelRecoveryWithAccountAndGuardians",
    title: "Keep the narrow recovery-cancellation escape hatch",
    summary: "While frozen, the only account execution allowed is a zero-value call to an installed recovery module cancelling this account's pending recovery.",
    state: "A successful frozen cancellation advances account configuration and invalidates stale schedules.",
    invariant: "Target, selector, account argument, call type, and zero value are all constrained."
  },
  {
    id: "freeze-expire",
    layer: "account-core",
    actor: "On-chain clock",
    contract: "LoomAccount",
    function: "unfreeze",
    title: "Expire without guardian liveness",
    summary: "After five days, an account-authorized self-call clears the expired marker; no guardian or service is required.",
    state: "frozenUntil becomes zero and Frozen(0) is emitted.",
    invariant: "Current account authority cannot shorten an active guardian freeze."
  }
]);

const FREEZE_EDGES = Object.freeze([
  ["freeze-digest", "freeze-submit", "signed capability"],
  ["freeze-submit", "freeze-membership", "guardianRoot + nonce + configVersion"],
  ["freeze-membership", "freeze-verify", "digest + signature"],
  ["freeze-verify", "freeze-write", "valid == true"],
  ["freeze-write", "freeze-block", "frozenUntil"],
  ["freeze-block", "freeze-escape", "only allowed account call"],
  ["freeze-block", "freeze-expire", "after 5 days"]
].map(([from, to, label]) => ({ from, to, label })));

const RECOVERY_LAYOUTS = Object.freeze({
  recovery: Object.freeze({
    width: 2420,
    height: 560,
    positions: Object.freeze({
      provision: { x: 40, y: 125 },
      digest: { x: 300, y: 125 },
      announce: { x: 300, y: 350 },
      approve: { x: 560, y: 125 },
      "publish-approval": { x: 560, y: 350 },
      assemble: { x: 820, y: 125 },
      propose: { x: 1080, y: 125 },
      delay: { x: 1340, y: 125 },
      execute: { x: 1600, y: 125 },
      "core-handoff": { x: 1860, y: 125 },
      "core-apply": { x: 2120, y: 125 },
      "publish-cancellation": { x: 1340, y: 350 },
      "cancel-account": { x: 1660, y: 350 },
      "cancel-guardians": { x: 1980, y: 350 }
    })
  }),
  freeze: Object.freeze({
    width: 2050,
    height: 500,
    positions: Object.freeze({
      "freeze-digest": { x: 40, y: 135 },
      "freeze-submit": { x: 300, y: 135 },
      "freeze-membership": { x: 560, y: 135 },
      "freeze-verify": { x: 820, y: 135 },
      "freeze-write": { x: 1080, y: 135 },
      "freeze-block": { x: 1340, y: 135 },
      "freeze-expire": { x: 1800, y: 135 },
      "freeze-escape": { x: 1510, y: 335 }
    })
  })
});

export const RECOVERY_FLOW_MODES = Object.freeze({
  recovery: {
    label: "Guardian recovery",
    description: "Threshold approval, public delay, cancellation, and atomic authority rotation.",
    nodes: RECOVERY_NODES,
    edges: RECOVERY_EDGES
  },
  freeze: {
    label: "Emergency freeze",
    description: "One-guardian veto with bounded duration and a narrowly constrained cancellation escape hatch.",
    nodes: FREEZE_NODES,
    edges: FREEZE_EDGES
  }
});

export function buildRecoveryLifecycle(mode = "recovery", selectedId = null) {
  const flow = RECOVERY_FLOW_MODES[mode] ?? RECOVERY_FLOW_MODES.recovery;
  const resolvedMode = RECOVERY_FLOW_MODES[mode] ? mode : "recovery";
  const layout = RECOVERY_LAYOUTS[resolvedMode];
  const selected = flow.nodes.find(node => node.id === selectedId) ?? flow.nodes[0];
  return {
    ...flow,
    mode: resolvedMode,
    layout,
    nodes: flow.nodes.map(node => ({ ...node, ...layout.positions[node.id] })),
    selected
  };
}
