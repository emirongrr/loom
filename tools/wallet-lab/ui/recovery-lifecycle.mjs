const RECOVERY_NODES = Object.freeze([
  {
    id: "provision",
    actor: "Recovering device",
    contract: "P256RecoveryValidatorFactory",
    function: "deployForRecovery",
    title: "Commit the new passkey validator",
    summary: "CREATE2 reserves a validator for one account, recovery nonce, and initialization-data hash.",
    state: "A deterministic P256RecoveryValidator exists and accepts only the committed initialization.",
    invariant: "The factory is ownerless and cannot redirect or reuse the reservation."
  },
  {
    id: "digest",
    actor: "Recovery client",
    contract: "RecoveryManager",
    function: "proposalDigest",
    title: "Bind the complete recovery intent",
    summary: "The EIP-712 digest binds the account, complete old validator set, new validator, init-data hash, fresh guardian root, config version, nonce, chain, and manager.",
    state: "No on-chain state changes; guardians receive one exact intent to review.",
    invariant: "Changing any authority-bearing field invalidates every collected approval."
  },
  {
    id: "approve",
    actor: "Guardian threshold",
    contract: "Guardian verifiers",
    function: "verify",
    title: "Verify independent guardian approvals",
    summary: "Sorted Merkle proofs bind each guardian verifier, verifier code hash, key commitment, and salt to the current guardian root.",
    state: "Approvals remain portable evidence until proposal submission; they grant no spending authority.",
    invariant: "Duplicate leaves, duplicate commitments, invalid proofs, and verifier failures reject the proposal."
  },
  {
    id: "propose",
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
    actor: "On-chain clock",
    contract: "RecoveryManager",
    function: "RECOVERY_DELAY / RECOVERY_WINDOW",
    title: "Wait 3 days; expose a 7-day execution window",
    summary: "The visible delay gives the current account and guardians time to detect and contest a malicious proposal.",
    state: "Execution rejects before readyAt and after expiresAt.",
    invariant: "The account config version must remain the version approved by guardians."
  },
  {
    id: "cancel-account",
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
    actor: "Full guardian threshold",
    contract: "RecoveryManager",
    function: "cancelRecoveryWithGuardians",
    title: "Cancel without current account authority",
    summary: "Guardians can reject a malicious or obsolete proposal even when the current validator is unavailable.",
    state: "Pending recovery is deleted and its nonce advances.",
    invariant: "The full current guardian threshold must approve the cancellation digest."
  },
  {
    id: "execute",
    actor: "Any publisher",
    contract: "RecoveryManager → LoomAccount",
    function: "executeRecovery → recoverConfiguration",
    title: "Atomically replace authority",
    summary: "During the window, anyone can submit the exact old validator set and init data committed by guardians.",
    state: "Old validators are replaced, the new validator initializes, guardian root and threshold rotate, config version and recovery nonce advance.",
    invariant: "Execution is permissionless but not discretionary: hashes and the approved config version must match exactly."
  }
]);

const RECOVERY_EDGES = Object.freeze([
  ["provision", "digest", "validator + initDataHash"],
  ["digest", "approve", "EIP-712 intent"],
  ["approve", "propose", "threshold approvals"],
  ["propose", "delay", "RecoveryProposed"],
  ["delay", "execute", "ready and not expired"],
  ["delay", "cancel-account", "contest path"],
  ["delay", "cancel-guardians", "guardian veto"],
  ["cancel-account", "propose", "new nonce; restart only"],
  ["cancel-guardians", "propose", "new nonce; restart only"]
].map(([from, to, label]) => ({ from, to, label })));

const FREEZE_NODES = Object.freeze([
  {
    id: "freeze-digest",
    actor: "Guardian client",
    contract: "LoomAccount",
    function: "guardianLeaf / FREEZE_TYPEHASH",
    title: "Bind one configured guardian",
    summary: "The digest binds the guardian leaf, that leaf's freeze nonce, and the current account config version.",
    state: "No state changes before proof and signature verification.",
    invariant: "A capability copied from another account, config version, or guardian leaf cannot be replayed."
  },
  {
    id: "freeze-verify",
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
  ["freeze-digest", "freeze-verify", "proof + signature"],
  ["freeze-verify", "freeze-write", "valid guardian capability"],
  ["freeze-write", "freeze-block", "frozenUntil"],
  ["freeze-block", "freeze-escape", "only allowed account call"],
  ["freeze-block", "freeze-expire", "after 5 days"]
].map(([from, to, label]) => ({ from, to, label })));

const RECOVERY_LAYOUTS = Object.freeze({
  recovery: Object.freeze({
    width: 1760,
    height: 520,
    positions: Object.freeze({
      provision: { x: 40, y: 125 },
      digest: { x: 300, y: 125 },
      approve: { x: 560, y: 125 },
      propose: { x: 820, y: 125 },
      delay: { x: 1080, y: 125 },
      execute: { x: 1460, y: 125 },
      "cancel-account": { x: 1080, y: 335 },
      "cancel-guardians": { x: 1400, y: 335 }
    })
  }),
  freeze: Object.freeze({
    width: 1510,
    height: 500,
    positions: Object.freeze({
      "freeze-digest": { x: 40, y: 135 },
      "freeze-verify": { x: 310, y: 135 },
      "freeze-write": { x: 580, y: 135 },
      "freeze-block": { x: 850, y: 135 },
      "freeze-expire": { x: 1200, y: 135 },
      "freeze-escape": { x: 1030, y: 335 }
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
