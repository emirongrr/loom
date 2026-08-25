import { buildArchitectureExplorer, buildFunctionExecutionLens, buildTransactionArchitectureJourney, reduceArchitectureFocus } from "./architecture-explorer.mjs";
import { layoutArchitectureExplorer } from "./graph-layout.mjs";
import { defaultExecutionArgument, executionArgumentExample } from "./execution-defaults.mjs";
import { buildOperationLens } from "./lab-domain.mjs";
import { buildRecoveryLifecycle } from "./recovery-lifecycle.mjs";
import { zoomScrollAtPoint, zoomTransformAtPoint } from "./viewport-zoom.mjs";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const EMPTY = "-";
const state = {
  artifact: null,
  artifactRevision: null,
  sepoliaDeployment: null,
  deploymentSource: "local",
  deploymentChosen: false,
  activeTab: "architecture",
  selectedNetworkIndex: 0,
  selectedNetworkOperation: "all",
  networkSearch: "",
  networkTransport: "all",
  functionSearch: "",
  selectedContractId: null,
  selectedFunctionSelector: null,
  selectedAuthorityId: null,
  selectedDisclosureId: null,
  graphTransform: { x: 0, y: 0, scale: 1 },
  graphNodeOffsets: {},
  graphInteraction: null,
  ignoreGraphClick: false,
  architectureImmersive: false,
  architectureSearch: "",
  architectureTransactionOpen: false,
  expandedArchitectureGroups: [],
  recoveryMode: "recovery",
  selectedRecoveryStepId: "provision",
  recoveryZoom: 1,
  recoveryScrollLeft: 0,
  recoveryScrollTop: 0,
  focusedNodeId: null,
  focusedSection: null,
  focusedAbiItem: null,
  focusedEdgeId: null,
  traceOverlayEnabled: false,
  selectedTracePath: "0",
  traceSearch: "",
  traceType: "all",
  opcodeView: "important",
  functionValues: {},
  functionCallValue: "0",
  functionCaller: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  executionStatus: "idle",
  executionResult: null,
  executionProbeResult: null,
  executionError: null,
  executionSepoliaConfirmed: false,
  executionTransactionHash: "",
  executionSearch: "",
  executionFunctionMode: "all",
  exampleNowSeconds: Math.floor(Date.now() / 1_000)
};

const LOCAL_TEST_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const escapeHtml = value => String(value ?? EMPTY).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const format = value => typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
const short = (value, front = 10, back = 8) => value && String(value).length > front + back + 3 ? `${String(value).slice(0, front)}...${String(value).slice(-back)}` : value ?? EMPTY;
const titleCase = value => String(value ?? "").split("-").map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");

function resetExecutionState({ global = false } = {}) {
  state.executionStatus = "idle";
  state.executionResult = null;
  state.executionError = null;
  state.executionSepoliaConfirmed = false;
  if (global) {
    state.executionProbeResult = null;
    state.executionTransactionHash = "";
  }
}

function statusClass(status) {
  if (["success", "finalized", "confirmed", "included", "pass", "healthy"].includes(status)) return "success";
  if (["error", "reverted", "dropped", "reorganized", "fail", "unhealthy"].includes(status)) return "error";
  return "waiting";
}

function duration(artifact) {
  if (!artifact?.finishedAt) return "Live";
  const elapsed = Math.max(0, new Date(artifact.finishedAt) - new Date(artifact.startedAt));
  return elapsed < 1_000 ? `${elapsed} milliseconds` : `${(elapsed / 1_000).toFixed(1)} seconds`;
}

function runOutcomeLabel(status) {
  if (statusClass(status) === "success") return "Scenario completed";
  if (statusClass(status) === "error") return "Scenario stopped";
  return status === "running" ? "Scenario in progress" : "Waiting for evidence";
}

function networkLabel(chainId) {
  if (Number(chainId) === 31337) return "Local Anvil devnet";
  if (Number(chainId) === 11155111) return "Ethereum Sepolia";
  return chainId === undefined || chainId === null ? "Network unavailable" : `Chain ${chainId}`;
}

function artifactRevision(artifact) {
  const events = artifact?.events ?? [];
  const latest = events.at(-1);
  return [artifact?.runId, artifact?.status, artifact?.finishedAt, events.length, latest?.monotonicSequence, latest?.timestamp].join("|");
}

function detailsIdentity(details) {
  const scope = details.closest(".workspace-panel") ?? document;
  const panel = scope.id || "page";
  const position = [...scope.querySelectorAll("details")].indexOf(details);
  const summary = details.querySelector(":scope > summary")?.textContent?.trim() ?? "details";
  return `${panel}:${position}:${summary}`;
}

function captureOpenDetails() {
  return new Map($$("details").map(details => [detailsIdentity(details), details.open]));
}

function restoreOpenDetails(snapshot) {
  for (const details of $$("details")) {
    const open = snapshot.get(detailsIdentity(details));
    if (open !== undefined) details.open = open;
  }
}

function jsonBlock(value, label = "JSON evidence") {
  return `<pre aria-label="${escapeHtml(label)}">${escapeHtml(format(value))}</pre>`;
}

function field(label, value, options = {}) {
  const rendered = options.short ? short(value, options.front, options.back) : value;
  return `<div class="evidence-field"><span>${escapeHtml(label)}</span><${options.code ? "code" : "strong"} title="${escapeHtml(value)}">${escapeHtml(rendered)}</${options.code ? "code" : "strong"}></div>`;
}

function renderEnvironment(environment) {
  const root = $("#environment");
  if (!environment) {
    root.className = "metric-grid empty";
    root.textContent = "No environment manifest yet.";
    return;
  }
  root.className = "metric-grid";
  const core = [
    ["Chain ID", environment.chainId],
    ["Git commit", short(environment.gitCommit)],
    ["Working tree", environment.dirty ? "Dirty" : "Clean"],
    ["Snapshot", environment.snapshotId ?? "Pending"]
  ];
  root.innerHTML = core.map(([label, value]) => field(label, value, { code: label !== "Working tree" })).join("") +
    (environment.components ?? []).map(component => `<div class="evidence-field"><span>${escapeHtml(component.name)}</span><strong>${escapeHtml(component.version)}</strong><small class="health ${statusClass(component.status)}">${escapeHtml(component.status)}</small></div>`).join("");
}

function renderState(values = []) {
  const root = $("#state-diff");
  if (!values.length) {
    root.className = "state-grid empty";
    root.textContent = "State has not changed yet.";
    return;
  }
  root.className = "state-grid";
  root.innerHTML = values.map(value => `<article><span>${escapeHtml(value.name)}</span><div class="state-values"><code>${escapeHtml(format(value.before))}</code><b aria-hidden="true">to</b><code>${escapeHtml(format(value.after))}</code></div><p>${escapeHtml(value.explanation)}</p></article>`).join("");
}

const invariantLabels = {
  "sdk-entrypoint-userop-hash-match": "Same operation ID",
  "receipt-provenance-match": "Correct on-chain receipt",
  "native-balance-delta-match": "Exact amount transferred",
  "target-state-transition-match": "Expected contract state changed",
  "finality-not-inferred-from-simulation": "Final only after on-chain confirmation"
};

const journeyStages = [
  { title: "Wallet ready", text: "The account and test environment were resolved.", phases: ["environment", "ui", "account-resolution"] },
  { title: "Call prepared", text: "The wallet built the call and checked its gas requirements.", phases: ["intent", "call-construction", "gas-estimation"] },
  { title: "Passkey approved", text: "The passkey authorized this exact wallet operation.", phases: ["webauthn"] },
  { title: "Sent through bundler", text: "A bundler forwarded the signed request to EntryPoint.", phases: ["bundler-submission"] },
  { title: "Confirmed on chain", text: "The chain included the operation and the expected state changed.", phases: ["inclusion", "evm-trace", "finality", "state-after"] }
];

function lastEventForPhases(events, phases) {
  return [...events].reverse().find(event => phases.includes(event.phase));
}

function renderJourney(artifact) {
  const events = artifact.events ?? [];
  const outcome = $("#journey-outcome");
  const succeeded = statusClass(artifact.status) === "success";
  outcome.className = `surface outcome-card ${statusClass(artifact.status)}`;
  outcome.innerHTML = `<div><p class="eyebrow">WHAT HAPPENED</p><h2>${escapeHtml(succeeded ? "The wallet operation completed" : artifact.status === "running" ? "The wallet operation is running" : "The wallet operation needs attention")}</h2><p>${escapeHtml(succeeded ? "The passkey approved the request, a bundler submitted it, and the chain confirmed the expected result." : artifact.firstFailingBoundary ? `The run stopped at ${titleCase(artifact.firstFailingBoundary)}. Open the matching step or Network evidence to diagnose it.` : "Wallet Lab is waiting for more evidence.")}</p></div><span class="status ${statusClass(artifact.status)}">${escapeHtml(artifact.status)}</span>`;

  $("#journey-flow").innerHTML = journeyStages.map((stage, index) => {
    const event = lastEventForPhases(events, stage.phases);
    const stepStatus = event ? statusClass(event.status) : "waiting";
    return `<article class="journey-step ${stepStatus}"><span class="journey-number">${index + 1}</span><div><strong>${escapeHtml(stage.title)}</strong><p>${escapeHtml(stage.text)}</p>${event ? `<small>${escapeHtml(titleCase(event.status))}${event.durationMs === undefined ? "" : ` / ${escapeHtml(event.durationMs)} ms`}</small>` : "<small>Waiting</small>"}</div></article>`;
  }).join("");

  const proofs = artifact.invariants ?? [];
  const proofRoot = $("#proof-list");
  proofRoot.className = proofs.length ? "proof-list" : "proof-list empty";
  proofRoot.innerHTML = proofs.length ? proofs.map(value => `<article class="proof-row ${statusClass(value.status)}"><span aria-hidden="true">${statusClass(value.status) === "success" ? "✓" : "!"}</span><div><strong>${escapeHtml(invariantLabels[value.id] ?? titleCase(value.id))}</strong><p>${escapeHtml(value.explanation)}</p></div><small>${escapeHtml(value.status)}</small></article>`).join("") : "No checks yet.";

  $("#technical-events").innerHTML = events.length ? events.map(event => `<li><span>${escapeHtml(event.monotonicSequence)}</span><div><strong>${escapeHtml(titleCase(event.phase))}</strong><small>${escapeHtml(event.component)}</small></div><em class="${statusClass(event.status)}">${escapeHtml(event.status)}</em></li>`).join("") : `<li class="empty">No stages recorded.</li>`;
  renderEnvironment(artifact.environment);
  renderState(artifact.stateDiff);
  $("#replay").textContent = `${artifact.replay.command}\nseed=${artifact.replay.seed}\nschema=${artifact.schema}@${artifact.version}\nredaction=${artifact.redaction.level}`;
}

function richestUserOperationEvent(events) {
  return [...events].reverse().find(event => event.payload?.userOperation && event.payload?.packedUserOperation)
    ?? [...events].reverse().find(event => event.payload?.unpacked)
    ?? [...events].reverse().find(event => event.payload?.userOperation);
}

function renderOperation(events = []) {
  const root = $("#operation-inspector");
  const event = richestUserOperationEvent(events);
  if (!event) {
    root.className = "empty-state";
    root.textContent = "No wallet operation evidence is available yet.";
    return;
  }
  const payload = event.payload ?? {};
  const operation = payload.userOperation ?? payload.unpacked ?? {};
  const packed = payload.packedUserOperation ?? payload.packed ?? null;
  const independent = payload.independentHash ?? payload.independentlyComputedHash ?? payload.userOpHash;
  const bundlerHash = payload.bundlerHash ?? event.userOpHash;
  const hashMatch = Boolean(independent && bundlerHash && String(independent).toLowerCase() === String(bundlerHash).toLowerCase());
  const inclusion = lastEventForPhases(events, ["finality", "inclusion"]);
  const submitted = lastEventForPhases(events, ["bundler-submission"]);
  const confirmed = Boolean(inclusion?.transactionHash);
  const route = [
    ["Wallet", "Builds the requested call", Boolean(operation.sender)],
    ["Passkey", "Approves this exact operation", Boolean(richestWebAuthnEvent(events))],
    ["Bundler", "Forwards it without owning the wallet", Boolean(submitted)],
    ["EntryPoint", "Checks and executes the request", Boolean(event.entryPoint)],
    ["Loom account", "Performs the call on chain", confirmed]
  ];
  root.className = "inspector-stack";
  root.innerHTML = `<article class="surface hero-inspector"><div class="inspector-heading"><div><p class="eyebrow">WALLET OPERATION</p><h2>${escapeHtml(confirmed ? "Confirmed on chain" : submitted ? "Sent to the bundler" : "Prepared by the wallet")}</h2><p>A wallet operation asks a smart account to perform a call. The passkey authorizes it and a bundler forwards it; the bundler never gains control of the account.</p></div><span class="status ${confirmed ? "success" : "waiting"}">${confirmed ? "Confirmed" : submitted ? "Submitted" : "Prepared"}</span></div></article><div class="operation-route">${route.map(([name, text, done], index) => `<article class="route-node ${done ? "success" : "waiting"}"><span>${index + 1}</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(text)}</small></article>`).join("")}</div><article class="surface"><div class="section-title"><div><p class="eyebrow">IDENTITY</p><h2>Which request was processed?</h2></div><span>${hashMatch ? "Operation ID matched" : "Awaiting independent match"}</span></div><div class="evidence-grid">${field("Smart account", operation.sender ?? event.account, { code: true, short: true })}${field("Wallet nonce", operation.nonce, { code: true })}${field("Operation ID", bundlerHash, { code: true, short: true })}${field("Chain transaction", inclusion?.transactionHash ?? "Not confirmed yet", { code: true, short: true })}</div><details><summary>Technical details</summary><div class="technical-grid"><section><h3>Routing and fees</h3><div class="stacked-fields">${field("EntryPoint", event.entryPoint, { code: true, short: true })}${field("Chain ID", event.chainId, { code: true })}${field("Call gas", operation.callGasLimit ?? EMPTY, { code: true })}${field("Verification gas", operation.verificationGasLimit ?? EMPTY, { code: true })}${field("Pre-verification gas", operation.preVerificationGas ?? EMPTY, { code: true })}${field("Max fee / gas", operation.maxFeePerGas ?? EMPTY, { code: true })}${field("Priority fee / gas", operation.maxPriorityFeePerGas ?? EMPTY, { code: true })}</div></section><section><h3>Provenance</h3><div class="stacked-fields">${field("Independent hash", independent, { code: true, short: true })}${field("Bundler hash", bundlerHash, { code: true, short: true })}${field("Signature bytes", operation.signature ? Math.max(0, (String(operation.signature).length - 2) / 2) : EMPTY, { code: true })}${field("Factory", operation.factory ?? "Already deployed", { code: true, short: true })}${field("Paymaster", operation.paymaster ?? "Account funded", { code: true, short: true })}</div></section><section class="span-two"><h3>Unpacked operation</h3>${jsonBlock(operation, "Unpacked UserOperation")}${packed ? `<details><summary>Packed operation</summary>${jsonBlock(packed, "Packed UserOperation")}</details>` : ""}</section></div></details></article>`;
}

function richestWebAuthnEvent(events) {
  return [...events].reverse().find(event => event.phase === "webauthn" && (event.payload?.clientDataJSON || event.payload?.r || event.payload?.authenticatorData))
    ?? [...events].reverse().find(event => event.phase === "webauthn");
}

function parseClientData(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function renderPasskeyProof(events = []) {
  const root = $("#passkey-inspector");
  const event = richestWebAuthnEvent(events);
  if (!event) {
    root.className = "empty-state";
    root.innerHTML = "<h2>What the passkey proved</h2><p>No passkey evidence is available yet.</p>";
    return;
  }
  const data = event.payload ?? {};
  const clientData = parseClientData(data.clientDataJSON);
  const flags = data.flags && typeof data.flags === "object" ? data.flags : {};
  const checks = [
    ["Correct website", Boolean(data.rpId && data.origin), `${data.rpId ?? "Unknown site"} / ${data.origin ?? "Unknown origin"}`],
    ["User was present", flags.up === true || flags.userPresent === true, "The authenticator recorded user presence (UP)."],
    ["User was verified", flags.uv === true || flags.userVerified === true, "The authenticator recorded local user verification (UV)."],
    ["Bound to this operation", Boolean((data.challenge ?? clientData?.challenge) && (data.userOpHash ?? event.userOpHash)), "The signed challenge identifies this wallet operation, preventing reuse for another request."]
  ];
  root.className = "inspector-stack";
  root.innerHTML = `<article class="surface hero-inspector"><div class="inspector-heading"><div><p class="eyebrow">PASSKEY PROOF</p><h2>What the passkey proved</h2><p>The passkey did not send funds by itself. It proved that the expected site asked an available authenticator to approve this exact wallet operation.</p></div><span class="status ${statusClass(event.status)}">${statusClass(event.status) === "success" ? "Verified" : escapeHtml(event.status)}</span></div></article><div class="passkey-check-grid">${checks.map(([name, passed, text]) => `<article class="passkey-check ${passed ? "success" : "error"}"><span aria-hidden="true">${passed ? "✓" : "!"}</span><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(text)}</p></div></article>`).join("")}</div><article class="surface"><details><summary>Technical details</summary><div class="evidence-grid">${field("Credential ID", data.credentialId, { code: true, short: true })}${field("Challenge", data.challenge ?? clientData?.challenge ?? EMPTY, { code: true, short: true })}${field("RP ID hash", data.rpIdHash ?? EMPTY, { code: true, short: true })}${field("Signature encoding", data.signatureEncoding ?? "P-256 WebAuthn", { code: true })}${field("Signature r", data.r ?? EMPTY, { code: true, short: true })}${field("Signature s", data.s ?? EMPTY, { code: true, short: true })}${field("Operation ID", data.userOpHash ?? event.userOpHash ?? EMPTY, { code: true, short: true })}</div>${jsonBlock(data, "Raw WebAuthn evidence")}</details></article>`;
}

function networkExchanges(events = []) {
  let sequence = 0;
  return events.flatMap(event => event.phase === "network" && Array.isArray(event.payload?.exchanges)
    ? event.payload.exchanges.map(exchange => ({
      ...exchange,
      evidenceSpanId: event.spanId,
      index: sequence++,
      operation: exchange.operation ?? "observed-wallet-run",
      stage: exchange.stage ?? "unclassified",
      requirement: exchange.requirement ?? "observed-only",
      explanation: exchange.explanation ?? "This exchange was captured, but this older artifact does not identify the operation stage that caused it. Rerun the lab to attach that context."
    }))
    : []);
}

const SDK_TO_CHAIN_STAGES = [
  {
    id: "intent",
    layer: "Wallet intent",
    title: "prepareCalls",
    artifact: "Typed calls + review model",
    phase: "call-construction",
    rpc: "none",
    contract: "LoomAccount",
    consumer: "execute(bytes32,bytes)",
    explanation: "Encodes the exact targets, values, calldata, authority requirements, and execution mode the user is asked to authorize."
  },
  {
    id: "operation",
    layer: "Loom SDK",
    title: "fillUserOperation",
    artifact: "ERC-4337 UserOperation",
    phase: "gas-estimation",
    rpc: "eth_estimateUserOperationGas",
    contract: "EntryPoint",
    consumer: "simulateValidation / handleOps",
    explanation: "Resolves nonce, fees, deployment data, and gas fields without making the bundler an authority over the account."
  },
  {
    id: "authorization",
    layer: "Passkey boundary",
    title: "createPasskeySigner",
    artifact: "Validator signature envelope",
    phase: "webauthn",
    rpc: "WebAuthn ceremony",
    contract: "P256Validator",
    consumer: "validateUserOp",
    explanation: "Binds the passkey assertion to the canonical UserOperation hash, RP ID, origin, and configured validator."
  },
  {
    id: "publication",
    layer: "Bundler transport",
    title: "sendUserOperation",
    artifact: "UserOperation hash",
    phase: "bundler-submission",
    rpc: "eth_sendUserOperation",
    contract: "EntryPoint",
    consumer: "handleOps",
    explanation: "Publishes an already authorized operation. The bundler can delay or reject it but cannot rewrite the signed intent."
  },
  {
    id: "execution",
    layer: "On-chain authority",
    title: "validate + execute",
    artifact: "Receipt + state transition",
    phase: "inclusion",
    rpc: "eth_getUserOperationReceipt",
    contract: "ObservedAccount",
    consumer: "validateUserOp → execute",
    explanation: "EntryPoint invokes the account, the installed validator checks authority, and the account applies hooks before touching the target."
  },
  {
    id: "finality",
    layer: "Independent chain read",
    title: "verify finality",
    artifact: "Block + invariant evidence",
    phase: "finality",
    rpc: "eth_getTransactionReceipt / eth_blockNumber",
    contract: "EntryPoint",
    consumer: "UserOperationEvent + receipt",
    explanation: "Treats inclusion, receipt provenance, expected state, and later-block confirmation as separate checks."
  }
];

function latestPhaseEvent(events, phase) {
  return [...events].reverse().find(event => event.phase === phase) ?? null;
}

function renderSdkRpcLayer(events = []) {
  const deployment = currentDeployment(events);
  const exchanges = networkExchanges(events);
  const nodes = deployment?.nodes ?? [];
  const addressFor = name => nodes.find(node => node.id === name || node.name === name)?.address ?? null;
  const flow = $("#sdk-boundary-flow");
  flow.className = "sdk-boundary-flow";
  flow.innerHTML = SDK_TO_CHAIN_STAGES.map((stage, index) => {
    const evidence = latestPhaseEvent(events, stage.phase);
    const observed = Boolean(evidence);
    const address = addressFor(stage.contract);
    return `<article class="sdk-stage ${observed ? statusClass(evidence.status) : "architectural"}"><header><span>${index + 1}</span><div><small>${escapeHtml(stage.layer)}</small><strong>${escapeHtml(stage.title)}</strong></div><em>${observed ? "Observed" : "Architecture"}</em></header><p>${escapeHtml(stage.explanation)}</p><dl><div><dt>Produces</dt><dd>${escapeHtml(stage.artifact)}</dd></div><div><dt>Boundary</dt><dd><code>${escapeHtml(stage.rpc)}</code></dd></div><div><dt>Consumed by</dt><dd>${escapeHtml(stage.contract)}${address ? ` · ${escapeHtml(short(address, 8, 6))}` : ""}</dd></div></dl></article>`;
  }).join("");

  const matrix = $("#sdk-contract-matrix");
  matrix.className = "sdk-contract-matrix";
  matrix.innerHTML = `<div class="section-title"><div><p class="eyebrow">SDK → RPC → CONTRACT</p><h2>Compatibility map</h2><p>This is the join point between off-chain construction and on-chain authority. SDK output is replaceable; only the configured contracts and valid signatures can authorize state changes.</p></div><span>${escapeHtml(exchanges.length)} captured exchanges</span></div><div class="sdk-matrix-scroll"><table><thead><tr><th>SDK stage</th><th>Produced artifact</th><th>RPC / boundary</th><th>Core consumer</th><th>Run evidence</th></tr></thead><tbody>${SDK_TO_CHAIN_STAGES.map(stage => { const evidence = latestPhaseEvent(events, stage.phase); return `<tr><td><strong>${escapeHtml(stage.title)}</strong><small>${escapeHtml(stage.layer)}</small></td><td>${escapeHtml(stage.artifact)}</td><td><code>${escapeHtml(stage.rpc)}</code></td><td><strong>${escapeHtml(stage.contract)}</strong><small>${escapeHtml(stage.consumer)}</small></td><td><span class="pill ${evidence ? statusClass(evidence.status) : "waiting"}">${evidence ? escapeHtml(titleCase(evidence.status)) : "Not captured"}</span></td></tr>`; }).join("")}</tbody></table></div>`;
}

const evidenceKindLabels = {
  observed_client: "Observed in client",
  observed_onchain: "Observed on-chain",
  observed_rpc: "Observed transport",
  observed_trace: "Observed trace",
  observed_receipt: "Receipt-bound",
  observed_event: "Observed event",
  observed_state_diff: "Verified state diff",
  derived_from_artifact: "Derived from artifact",
  derived_from_source: "Derived from source",
  derived_from_manifest: "Derived from manifest",
  derived_from_configuration: "Derived from configuration",
  derived_from_simulation: "Simulation only",
  inferred: "Inferred",
  unavailable: "Unavailable"
};

const abilityLabels = {
  approve: "Approve",
  reject: "Reject",
  veto: "Veto",
  constrain: "Constrain",
  publish: "Publish",
  delay: "Delay",
  refuse_service: "Refuse service",
  observe: "Observe",
  execute_transport: "Execute transport",
  settle_gas: "Settle gas",
  move_funds: "Move funds",
  execute: "Execute calls",
  change_configuration: "Change configuration",
  receive_value: "Receive value",
  receive_call: "Receive call"
};

const visibilityLabels = {
  local_only: "Local only",
  disclosed_to_specific_party: "Specific party",
  disclosed_to_infrastructure: "Infrastructure",
  disclosed_to_counterparty: "Counterparty",
  committed_onchain: "Committed on-chain",
  revealed_onchain: "Public on-chain",
  publicly_linkable: "Publicly linkable",
  conditionally_linkable: "Conditionally linkable",
  unknown: "Unknown"
};

function currentOperationLens(events = state.artifact?.events ?? []) {
  if (!state.artifact) return null;
  if (state.deploymentSource !== "local") return null;
  return buildOperationLens({
    artifact: state.artifact,
    deployment: currentDeployment(events),
    tracePayload: currentTrace(events),
    selectedContractId: state.selectedContractId
  });
}

function evidenceBadge(evidence) {
  if (!evidence) return `<span class="evidence-badge unavailable">Unavailable</span>`;
  return `<span class="evidence-badge ${escapeHtml(evidence.confidence)}">${escapeHtml(evidenceKindLabels[evidence.kind] ?? titleCase(evidence.kind))}</span>`;
}

function evidenceDetails(evidence = []) {
  if (!evidence.length) return `<p class="empty">No evidence reference is available.</p>`;
  return evidence.map(reference => {
    const details = Object.entries(reference).filter(([key]) => !["kind", "confidence", "description"].includes(key));
    return `<article class="evidence-reference"><div>${evidenceBadge(reference)}<strong>${escapeHtml(titleCase(reference.confidence))}</strong></div><p>${escapeHtml(reference.description)}</p>${details.length ? `<details><summary>Advanced evidence references</summary><dl>${details.map(([key, value]) => `<div><dt>${escapeHtml(titleCase(key))}</dt><dd><code>${escapeHtml(value)}</code></dd></div>`).join("")}</dl></details>` : ""}</article>`;
  }).join("");
}

function renderAuthorityView(lens) {
  const graph = $("#authority-graph");
  const actorsRoot = $("#authority-actors");
  const context = $("#authority-context");
  if (!lens?.authority?.actors?.length) {
    graph.className = "surface authority-graph empty";
    graph.textContent = "No authority evidence is available.";
    actorsRoot.className = "surface authority-actors empty";
    actorsRoot.textContent = "Select a run with client or trace evidence.";
    context.textContent = "Waiting for an operation.";
    return;
  }
  const actors = lens.authority.actors;
  if (!actors.some(actor => actor.id === state.selectedAuthorityId)) state.selectedAuthorityId = actors.find(actor => actor.id === state.selectedContractId)?.id ?? actors[0].id;
  const positions = new Map(actors.map((actor, index) => [actor.id, { x: 55 + (index % 3) * 345, y: 55 + Math.floor(index / 3) * 145 }]));
  const height = Math.max(220, Math.ceil(actors.length / 3) * 145 + 60);
  const edges = lens.authority.edges.map(edge => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) return "";
    const startX = from.x + 250;
    const startY = from.y + 36;
    const endX = to.x;
    const endY = to.y + 36;
    const bend = Math.max(45, Math.abs(endX - startX) * .45);
    return `<path d="M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}" marker-end="url(#authority-arrow)"><title>${escapeHtml(edge.explanation)}</title></path>`;
  }).join("");
  const nodes = actors.map(actor => {
    const position = positions.get(actor.id);
    const selected = actor.id === state.selectedAuthorityId ? " selected" : "";
    const evidence = actor.evidence.at(-1);
    return `<g class="authority-node${selected}" transform="translate(${position.x} ${position.y})" data-authority-id="${escapeHtml(actor.id)}" role="button" tabindex="0" aria-pressed="${actor.id === state.selectedAuthorityId}" aria-label="Inspect authority for ${escapeHtml(actor.label)}"><rect width="250" height="72" rx="9"></rect><text class="authority-node-kind" x="13" y="18">${escapeHtml(evidenceKindLabels[evidence?.kind] ?? "Unknown evidence")}</text><text class="authority-node-name" x="13" y="39">${escapeHtml(short(actor.label, 25, 5))}</text><text class="authority-node-ability" x="13" y="58">${escapeHtml(actor.abilities.slice(0, 3).map(ability => abilityLabels[ability] ?? titleCase(ability)).join(" · "))}</text></g>`;
  }).join("");
  graph.className = "surface authority-graph";
  graph.innerHTML = `<div class="section-title"><div><p class="eyebrow">AUTHORITY GRAPH</p><h2>Influence on this operation</h2><p>Edges mean authorization, enforcement, publication, or execution—not generic conceptual association.</p></div><span>${actors.length} evidenced actors</span></div><div class="authority-svg-scroll"><svg viewBox="0 0 1000 ${height}" role="img" aria-label="Authority and trust relationships for the selected operation"><defs><marker id="authority-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z"></path></marker></defs><g class="authority-edges">${edges}</g>${nodes}</svg></div>`;

  const selected = actors.find(actor => actor.id === state.selectedAuthorityId) ?? actors[0];
  actorsRoot.className = "surface authority-actors";
  actorsRoot.innerHTML = `<div class="section-title"><div><p class="eyebrow">SELECTED ACTOR</p><h2>${escapeHtml(selected.label)}</h2><p>${escapeHtml(selected.explanation)}</p></div>${evidenceBadge(selected.evidence.at(-1))}</div><div class="ability-list">${selected.abilities.map(ability => `<span>${escapeHtml(abilityLabels[ability] ?? titleCase(ability))}</span>`).join("")}</div><div class="authority-actor-list" aria-label="Authority actors">${actors.map(actor => `<button type="button" data-authority-id="${escapeHtml(actor.id)}" aria-pressed="${actor.id === selected.id}"><strong>${escapeHtml(actor.label)}</strong><small>${escapeHtml(actor.abilities.map(ability => abilityLabels[ability] ?? titleCase(ability)).join(" · "))}</small></button>`).join("")}</div><section class="lens-evidence"><h3>Why Wallet Lab can say this</h3>${evidenceDetails(selected.evidence)}</section>`;
  context.innerHTML = `<span>Operation</span><strong>${escapeHtml(lens.operation.title)}</strong><small>${escapeHtml(lens.operation.selectedContractId ? `Focused on ${lens.operation.selectedContractId}` : "Deployment-wide focus")}</small>`;
}

function renderPrivacyView(lens) {
  const map = $("#privacy-observer-map");
  const evidenceRoot = $("#privacy-evidence");
  const context = $("#privacy-context");
  const disclosures = lens?.privacy ?? [];
  if (!disclosures.length) {
    map.className = "privacy-observer-map empty";
    map.textContent = "No observer-specific evidence is available.";
    evidenceRoot.className = "surface privacy-evidence empty";
    evidenceRoot.textContent = "Select a disclosure to inspect its provenance.";
    context.textContent = "Waiting for an operation.";
    return;
  }
  if (!disclosures.some(disclosure => disclosure.id === state.selectedDisclosureId)) state.selectedDisclosureId = disclosures[0].id;
  map.className = "privacy-observer-map";
  map.innerHTML = disclosures.map(disclosure => `<button type="button" class="privacy-observer ${escapeHtml(disclosure.visibility)}" data-disclosure-id="${escapeHtml(disclosure.id)}" aria-pressed="${disclosure.id === state.selectedDisclosureId}"><span>${escapeHtml(visibilityLabels[disclosure.visibility] ?? titleCase(disclosure.visibility))}</span><strong>${escapeHtml(disclosure.observer)}</strong><p>${escapeHtml(disclosure.dataCategory)}</p>${evidenceBadge(disclosure.evidence[0])}</button>`).join("");
  const selected = disclosures.find(disclosure => disclosure.id === state.selectedDisclosureId) ?? disclosures[0];
  evidenceRoot.className = "surface privacy-evidence";
  evidenceRoot.innerHTML = `<div class="section-title"><div><p class="eyebrow">SELECTED DISCLOSURE</p><h2>${escapeHtml(selected.observer)}</h2><p>${escapeHtml(selected.explanation)}</p></div><span class="visibility ${escapeHtml(selected.visibility)}">${escapeHtml(visibilityLabels[selected.visibility] ?? titleCase(selected.visibility))}</span></div><div class="privacy-data-category"><span>Data visible to this observer</span><strong>${escapeHtml(selected.dataCategory)}</strong></div><section class="lens-evidence"><h3>Evidence and limits</h3>${evidenceDetails(selected.evidence)}</section>`;
  context.innerHTML = `<span>Operation</span><strong>${escapeHtml(lens.operation.title)}</strong><small>${escapeHtml(`${disclosures.length} evidenced observer disclosures`)}</small>`;
}

function renderSharedOperationLens(events = state.artifact?.events ?? []) {
  const lens = currentOperationLens(events);
  renderAuthorityView(lens);
  renderPrivacyView(lens);
}

function filteredNetwork(events) {
  return networkExchanges(events).filter(exchange => {
    const method = exchange.request?.method ?? "unknown";
    const searchable = [method, exchange.operation, exchange.stage, exchange.requirement, exchange.explanation].join(" ").toLowerCase();
    return (state.networkTransport === "all" || exchange.transport === state.networkTransport)
      && (state.selectedNetworkOperation === "all" || exchange.operation === state.selectedNetworkOperation)
      && (!state.networkSearch || searchable.includes(state.networkSearch.toLowerCase()));
  });
}

function operationLabel(value) {
  return ({
    "wallet-discovery": "Discover wallet",
    "account-activation": "Activate account",
    "native-transfer": "Send native asset",
    "observed-wallet-run": "Legacy recorded run"
  })[value] ?? titleCase(value);
}

function renderNetworkOperationGroups(events = []) {
  const root = $("#network-operation-groups");
  const exchanges = networkExchanges(events);
  const groups = [...new Set(exchanges.map(exchange => exchange.operation))];
  root.className = groups.length ? "network-operation-groups" : "network-operation-groups empty";
  root.innerHTML = groups.length ? ["all", ...groups].map(operation => {
    const count = operation === "all" ? exchanges.length : exchanges.filter(exchange => exchange.operation === operation).length;
    const active = operation === state.selectedNetworkOperation;
    return `<button type="button" data-network-operation="${escapeHtml(operation)}" class="${active ? "selected" : ""}" aria-pressed="${active}"><strong>${escapeHtml(operation === "all" ? "All observed calls" : operationLabel(operation))}</strong><span>${count} exchange${count === 1 ? "" : "s"}</span></button>`;
  }).join("") : "No JSON-RPC exchanges were captured.";
}

function renderOperationMap(events = []) {
  const root = $("#operation-map");
  const exchanges = networkExchanges(events);
  const operations = [...new Set(exchanges.map(exchange => exchange.operation))];
  if (!operations.length) {
    root.className = "operation-map empty";
    root.textContent = "No observed operations are available yet.";
    return;
  }
  root.className = "operation-map";
  root.innerHTML = operations.map((operation, operationIndex) => {
    const matches = exchanges.filter(exchange => exchange.operation === operation);
    const stages = [...new Set(matches.map(exchange => exchange.stage))];
    const legacy = operation === "observed-wallet-run";
    return `<article class="operation-card${legacy ? " legacy" : ""}"><div class="operation-card-heading"><span>${operationIndex + 1}</span><div><p class="eyebrow">OBSERVED OPERATION</p><h2>${escapeHtml(operationLabel(operation))}</h2></div><strong>${matches.length} calls</strong></div>${legacy ? `<p class="evidence-note">This artifact predates operation labels. Rerun Wallet Lab to split these calls into discovery, activation, and transfer stages without guessing.</p>` : `<ol>${stages.map(stage => { const stageCalls = matches.filter(exchange => exchange.stage === stage); return `<li><strong>${escapeHtml(titleCase(stage))}</strong><span>${stageCalls.length} RPC / bundler call${stageCalls.length === 1 ? "" : "s"}</span><small>${escapeHtml(stageCalls[0]?.explanation ?? "Observed during this stage.")}</small></li>`; }).join("")}</ol>`}<button type="button" data-open-network-operation="${escapeHtml(operation)}">Inspect network evidence</button></article>`;
  }).join("");
}

function renderNetwork(events = []) {
  renderSdkRpcLayer(events);
  renderNetworkOperationGroups(events);
  const exchanges = filteredNetwork(events);
  const rows = $("#network-rows");
  if (!exchanges.length) {
    rows.innerHTML = `<tr><td colspan="6" class="empty">No captured JSON-RPC exchanges match these filters.</td></tr>`;
    renderNetworkInspector(null);
    return;
  }
  if (state.selectedNetworkIndex >= exchanges.length) state.selectedNetworkIndex = 0;
  rows.innerHTML = exchanges.map((exchange, index) => {
    const responseState = exchange.response?.error ? "error" : exchange.response?.result !== undefined ? "success" : "waiting";
    return `<tr class="${index === state.selectedNetworkIndex ? "selected" : ""}"><td><button type="button" data-network-index="${index}" aria-label="Inspect ${escapeHtml(exchange.request?.method ?? "request")}">${exchange.index + 1}</button></td><td><span class="stage-label">${escapeHtml(titleCase(exchange.stage))}</span></td><td><span class="transport ${escapeHtml(exchange.transport ?? "rpc")}">${escapeHtml(exchange.transport ?? "rpc")}</span></td><td><code>${escapeHtml(exchange.request?.method ?? "unknown")}</code></td><td><span class="requirement ${escapeHtml(exchange.requirement)}">${escapeHtml(titleCase(exchange.requirement))}</span></td><td><span class="pill ${statusClass(responseState)}">${responseState}</span></td></tr>`;
  }).join("");
  renderNetworkInspector(exchanges[state.selectedNetworkIndex]);
}

function renderNetworkInspector(exchange) {
  const root = $("#network-inspector");
  if (!exchange) {
    root.className = "surface inspector-detail empty";
    root.textContent = "Select a request to compare its JSON-RPC request and response.";
    return;
  }
  const responseState = exchange.response?.error ? "error" : "success";
  root.className = "surface inspector-detail";
  root.innerHTML = `<div class="inspector-heading"><div><p class="eyebrow">${escapeHtml(operationLabel(exchange.operation))} / ${escapeHtml(titleCase(exchange.stage))}</p><h2>${escapeHtml(exchange.request?.method ?? "Unknown request")}</h2><p>${escapeHtml(exchange.explanation)}</p></div><span class="status ${responseState}">${exchange.response?.error ? "Rejected" : "Returned"}</span></div><div class="evidence-grid">${field("Requirement", titleCase(exchange.requirement))}${field("Transport", exchange.transport ?? "rpc", { code: true })}${field("HTTP status", exchange.status ?? EMPTY, { code: true })}${field("Request ID", exchange.request?.id ?? EMPTY, { code: true })}${field("Endpoint", exchange.endpoint ?? EMPTY, { code: true, short: true })}</div><div class="json-compare"><div><h3>Request</h3>${jsonBlock(exchange.request, "JSON-RPC request")}</div><div><h3>Response</h3>${jsonBlock(exchange.response, "JSON-RPC response")}</div></div>`;
}

function deploymentEvidence(events = []) {
  return [...events].reverse().find(event => event.phase === "deployment")?.payload?.deployment ?? null;
}

function evmTraceEvidence(events = []) {
  return [...events].reverse().find(event => event.phase === "evm-trace")?.payload ?? null;
}

function currentDeployment(events = state.artifact?.events ?? []) {
  return state.deploymentSource === "sepolia" ? state.sepoliaDeployment?.deployment ?? null : deploymentEvidence(events);
}

function currentTrace(events = state.artifact?.events ?? []) {
  if (state.deploymentSource === "sepolia") return state.executionResult?.kind === "transaction-analysis" ? state.executionResult : null;
  return evmTraceEvidence(events);
}

function renderDeploymentVerification() {
  const root = $("#deployment-verification");
  if (state.deploymentSource === "local") {
    root.className = "deployment-verification waiting";
    root.innerHTML = "<strong>Local evidence</strong><span>Captured by the deterministic Wallet Lab run.</span>";
    return;
  }
  const report = state.sepoliaDeployment;
  if (!report || report.status === "unavailable") {
    root.className = "deployment-verification error";
    root.innerHTML = "<strong>Sepolia unavailable</strong><span>Sepolia deployment is not configured. Start Wallet Lab with SEPOLIA_RPC_URL or --rpc-url.</span>";
    return;
  }
  const verified = report.status === "verified";
  root.className = `deployment-verification ${verified ? "success" : "error"}`;
  root.innerHTML = `<strong>${verified ? "Verified on Sepolia" : "Deployment mismatch"}</strong><span>${escapeHtml(verified ? `${report.checks.length}/${report.checks.length} runtime code hashes match via ${report.endpointOrigin}.` : `${report.failures.length} manifest commitment${report.failures.length === 1 ? " does" : "s do"} not match the live chain.`)}</span>`;
}

const requirementLabels = {
  core: ["Core account system", "Owns the smart-account execution and creation path."],
  "transport-required": ["ERC-4337 transport", "Required by the observed UserOperation route, not an owner of the wallet."],
  "deployment-required": ["Required recovery infrastructure", "Published by every supported deployment so accounts can configure sovereign guardian recovery."],
  "profile-required": ["Current security profile", "Required by this deployment profile to validate its configured account behavior."],
  optional: ["Optional modules", "Installed only when the account enables that capability; they do not become Loom core."],
  "test-only": ["Lab-only contracts", "Deterministic scenario helpers that are not part of a production deployment."]
};

function renderArchitectureSummary(deployment) {
  const root = $("#architecture-summary");
  if (!deployment?.nodes?.length) {
    root.className = "architecture-summary empty";
    root.textContent = "Choose an available deployment to classify its contracts.";
    return;
  }
  root.className = "architecture-summary";
  root.innerHTML = Object.entries(requirementLabels).map(([requirement, [label, description]]) => {
    const nodes = deployment.nodes.filter(node => node.requirement === requirement);
    return `<article class="architecture-role ${escapeHtml(requirement)}" title="${escapeHtml(description)}"><span>${nodes.length}</span><div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(description)}</p></div></article>`;
  }).join("");
}

function renderAccountModelExplainer(deployment) {
  const root = $("#account-model-explainer");
  const implementation = deployment?.nodes?.find(node => node.id === "LoomAccount");
  const instance = deployment?.nodes?.find(node => node.id === "ObservedAccount");
  if (!implementation || !instance) {
    root.hidden = true;
    root.replaceChildren();
    return;
  }
  root.hidden = false;
  root.className = "account-model-explainer";
  root.innerHTML = `<div class="account-model-node"><span>Shared code</span><strong>LoomAccount</strong><code>${escapeHtml(short(implementation.address, 10, 8))}</code></div><div class="delegation-arrow"><strong>DELEGATECALL</strong><span aria-hidden="true">→</span><small>code from implementation / state in proxy</small></div><div class="account-model-node instance"><span>Wallet instance</span><strong>Observed Loom account</strong><code>${escapeHtml(short(instance.address, 10, 8))}</code></div>`;
}

function architectureView(deployment) {
  return buildArchitectureExplorer(deployment, { expandedGroupIds: state.expandedArchitectureGroups, searchQuery: state.architectureSearch });
}

function graphPositions(nodes, edges) {
  const layout = layoutArchitectureExplorer(nodes, edges, { focusedNodeId: state.focusedNodeId, width: 1200, height: 760 });
  const positions = Object.fromEntries(nodes.map(node => {
    const offset = state.graphNodeOffsets[node.id] ?? { x: 0, y: 0 };
    const base = layout.positions[node.id];
    return [node.id, { x: base.x + offset.x, y: base.y + offset.y }];
  }));
  const bounds = Object.fromEntries(nodes.map(node => {
    const offset = state.graphNodeOffsets[node.id] ?? { x: 0, y: 0 };
    const base = layout.bounds[node.id];
    return [node.id, { ...base, x: base.x + offset.x, y: base.y + offset.y }];
  }));
  return { ...layout, positions, bounds };
}

function edgeClass(kind) {
  if (["validates-with", "guarded-by", "recovers", "optional-validator", "optional-hook"].includes(kind)) return "authority";
  if (["creates", "delegates", "provisions-for"].includes(kind)) return "create";
  return "call";
}

function observedTraceOverlay(deployment, tracePayload) {
  const empty = { nodeIds: new Set(), edges: [] };
  if (!state.traceOverlayEnabled || !deployment?.nodes?.length || !tracePayload?.trace) return empty;
  const addressToId = new Map(deployment.nodes.filter(node => node.address).map(node => [node.address.toLowerCase(), node.id]));
  const edgeCounts = new Map();
  for (const frame of flattenTrace(tracePayload.trace)) {
    const fromId = typeof frame.from === "string" ? addressToId.get(frame.from.toLowerCase()) : null;
    const toId = frame.contractId ?? (typeof frame.to === "string" ? addressToId.get(frame.to.toLowerCase()) : null);
    if (fromId) empty.nodeIds.add(fromId);
    if (toId) empty.nodeIds.add(toId);
    if (!fromId || !toId || fromId === toId) continue;
    const key = `${fromId}:${toId}:${frame.type ?? "CALL"}`;
    const current = edgeCounts.get(key) ?? { from: fromId, to: toId, type: frame.type ?? "CALL", count: 0 };
    current.count += 1;
    edgeCounts.set(key, current);
  }
  empty.edges = [...edgeCounts.values()];
  return empty;
}

const architectureSections = ["relationships", "functions", "fields", "events", "errors"];

function architectureEdgeId(edge) {
  return `${edge.from}:${edge.to}:${edge.kind}`;
}

function selectedFunctionLens(deployment) {
  if (!state.focusedNodeId || !state.focusedAbiItem) return null;
  return buildFunctionExecutionLens({
    deployment,
    contractId: state.focusedNodeId,
    functionSelector: state.focusedAbiItem,
    trace: currentTrace(state.artifact?.events ?? [])?.trace
  });
}

function traceData(value, empty = "none") {
  if (typeof value !== "string" || !value.length || value === "0x") return empty;
  return short(value, 18, 12);
}

function renderFunctionExecutionLens(deployment, contract, fn) {
  const lens = selectedFunctionLens(deployment);
  if (!lens) return "";
  const schema = items => items?.length ? items.map(item => item.type).join(", ") : "none";
  if (lens.status !== "observed") {
    return `<section class="function-execution-lens architecture-only"><header><div><p class="eyebrow">EXECUTION LENS</p><h3>Possible path, not observed</h3></div><span>ABI + architecture</span></header><p>This selector was not present in the recorded EVM trace. Highlighted neighboring contracts are architectural possibilities only; no call values, return data, gas, or state effects are invented.</p></section>`;
  }
  const calls = lens.calls.map((call, callIndex) => `<div class="function-call-run"><strong>Observed invocation ${callIndex + 1}</strong>${call.caller ? `<div class="execution-origin"><span>Caller</span><strong>${escapeHtml(call.caller.contractName ?? short(call.caller.from, 10, 8))}</strong><code>${escapeHtml(call.caller.callType)} → ${escapeHtml(fn.name)}</code></div>` : ""}<ol>${call.frames.map((frame, index) => {
    const target = deployment.nodes.find(node => node.id === frame.contractId);
    const targetFn = target?.functions?.find(candidate => candidate.selector === frame.selector);
    const label = frame.functionSignature ?? frame.selector ?? "fallback / receive";
    const result = frame.error ? `Reverted · ${frame.revertReason ?? frame.error}` : `Returned ${traceData(frame.output)}`;
    return `<li style="--lens-depth:${Math.min(frame.depth, 4)}"><div class="execution-step-marker"><span>${index + 1}</span><i></i></div><article class="execution-frame${frame.error ? " error" : ""}"><header><span>${escapeHtml(frame.type)}</span><strong>${escapeHtml(target?.name ?? frame.contractName ?? short(frame.to, 10, 8))}</strong><small>${escapeHtml(formatTraceNumber(frame.gasUsed))} gas</small></header><code>${escapeHtml(label)}</code><p>${escapeHtml(targetFn?.purpose ?? targetFn?.behavior ?? target?.responsibility ?? "Observed contract call frame.")}</p><dl><div><dt>Sends</dt><dd><code>${escapeHtml(traceData(frame.input))}</code><small>raw calldata · ${escapeHtml(formatTraceNumber(frame.value))} wei</small></dd></div><div><dt>Expects</dt><dd><code>${escapeHtml(schema(targetFn?.outputs))}</code><small>ABI return schema</small></dd></div><div><dt>Result</dt><dd><code>${escapeHtml(result)}</code><small>${frame.error ? "observed revert" : "observed raw output"}</small></dd></div></dl></article></li>`;
  }).join("")}</ol></div>`).join("");
  return `<section class="function-execution-lens observed"><header><div><p class="eyebrow">EXECUTION LENS</p><h3>Observed EVM path</h3></div><span>${lens.calls.length} invocation${lens.calls.length === 1 ? "" : "s"}</span></header><p>The glowing graph path and frames below come from the recorded transaction. Calldata and output stay raw unless ABI decoding is independently available.</p>${calls}</section>`;
}

function renderArchitectureFunctionDetail(contract, fn) {
  const parameters = items => items?.length ? items.map(item => `<li><code>${escapeHtml(item.type)}</code><strong>${escapeHtml(item.name || "unnamed")}</strong></li>`).join("") : `<li class="empty">None</li>`;
  const deployment = currentDeployment(state.artifact?.events ?? []);
  return `<div class="architecture-function-detail"><button type="button" class="focus-back" data-focus-back="functions">← All functions</button><p class="eyebrow">FUNCTION</p><h3>${escapeHtml(fn.name)}</h3><code class="function-signature">${escapeHtml(fn.signature)}</code><div class="function-facts"><span>${escapeHtml(fn.stateMutability)}</span><span>${escapeHtml(fn.selector)}</span></div><p>${escapeHtml(fn.purpose ?? fn.behavior ?? "Declared by the compiler ABI for this contract.")}</p><div class="function-io"><div><strong>Inputs</strong><ul>${parameters(fn.inputs)}</ul></div><div><strong>Outputs</strong><ul>${parameters(fn.outputs)}</ul></div></div>${renderFunctionExecutionLens(deployment, contract, fn)}</div>`;
}

function renderArchitectureSection(deployment, contract) {
  const section = state.focusedSection;
  if (!section) {
    const inbound = deployment.edges.filter(edge => edge.to === contract.id).length;
    const outbound = deployment.edges.filter(edge => edge.from === contract.id).length;
    return `<div class="focus-overview"><div><strong>${inbound}</strong><span>inbound</span></div><div><strong>${outbound}</strong><span>outbound</span></div><div><strong>${contract.functions?.length ?? 0}</strong><span>functions</span></div></div><p class="focus-hint">Choose a section to inspect only the evidence you need.</p>`;
  }
  if (section === "relationships") {
    const related = deployment.edges.filter(edge => edge.from === contract.id || edge.to === contract.id);
    return `<div class="focus-list">${related.map(edge => {
      const outgoing = edge.from === contract.id;
      const otherId = outgoing ? edge.to : edge.from;
      const other = deployment.nodes.find(node => node.id === otherId);
      const selected = architectureEdgeId(edge) === state.focusedEdgeId ? " selected" : "";
      return `<button type="button" class="focus-relation${selected}" data-focus-edge="${escapeHtml(architectureEdgeId(edge))}"><span>${outgoing ? "OUTBOUND" : "INBOUND"}</span><strong>${escapeHtml(other?.name ?? otherId)}</strong><small>${escapeHtml(edge.kind === "delegates" ? "DELEGATECALL · shared code / instance state" : edge.label)}</small></button>`;
    }).join("") || `<p class="empty">No cataloged relationship.</p>`}</div>`;
  }
  if (section === "functions") {
    const selected = contract.functions?.find(fn => (fn.selector || fn.signature) === state.focusedAbiItem);
    if (selected) return renderArchitectureFunctionDetail(contract, selected);
    return `<div class="focus-list">${(contract.functions ?? []).map(fn => `<button type="button" class="focus-abi-row" data-focus-function="${escapeHtml(fn.selector || fn.signature)}"><strong>${escapeHtml(fn.name)}</strong><code>${escapeHtml(fn.signature)}</code><span>${escapeHtml(fn.stateMutability)}</span></button>`).join("") || `<p class="empty">No callable functions.</p>`}</div>`;
  }
  if (section === "fields") return `<div class="focus-list focus-fields">${(contract.fields ?? []).map(item => renderFieldCard(item, "abi-value")).join("") || `<p class="empty">No compiler-declared fields.</p>`}</div>`;
  const items = section === "events" ? contract.events ?? [] : contract.errors ?? [];
  return `<div class="focus-list">${items.map(item => `<article class="focus-declaration ${section}"><strong>${escapeHtml(item.signature ?? item.name)}</strong><code>${escapeHtml(item.topic ?? item.selector ?? "")}</code><p>${escapeHtml(item.purpose ?? item.documentation ?? `Declared ${section.slice(0, -1)} in the compiler ABI.`)}</p></article>`).join("") || `<p class="empty">No ${escapeHtml(section)} in this ABI.</p>`}</div>`;
}

function renderFocusedArchitectureNode(deployment, contract, bounds, functionLens = null) {
  const sourceUrl = githubSourceUrl(contract.source);
  const tabs = architectureSections.map(section => {
    const counts = { relationships: deployment.edges.filter(edge => edge.from === contract.id || edge.to === contract.id).length, functions: contract.functions?.length ?? 0, fields: contract.fields?.length ?? 0, events: contract.events?.length ?? 0, errors: contract.errors?.length ?? 0 };
    return `<button type="button" data-focus-section="${section}" aria-pressed="${state.focusedSection === section}">${titleCase(section)} <span>${counts[section]}</span></button>`;
  }).join("");
  const lensClass = functionLens ? ` function-${functionLens.status}` : "";
  return `<foreignObject class="architecture-focus-object${lensClass}" data-contract-id="${escapeHtml(contract.id)}" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}"><div xmlns="http://www.w3.org/1999/xhtml" class="architecture-focus-node ${escapeHtml(contract.requirement)}"><header><div><p class="eyebrow">${escapeHtml(titleCase(contract.requirement))}</p><h2>${escapeHtml(contract.name)}</h2></div><button type="button" data-focus-close="true" aria-label="Close contract detail">×</button></header><div class="focus-identity">${renderContractAddress(contract)}${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Source ↗</a>` : ""}</div><p class="focus-responsibility">${escapeHtml(contract.responsibility ?? "Deployment contract")}</p><nav aria-label="Contract detail sections">${tabs}</nav><div class="focus-content">${renderArchitectureSection(deployment, contract)}</div></div></foreignObject>`;
}

function transactionClassification(result) {
  const classification = result?.provenance?.classification;
  if (classification === "loom-confirmed") return ["Verified Loom execution", "success", "Trusted deployment code or a verified Loom account runtime was observed."];
  if (classification === "erc4337-only") return ["ERC-4337 only", "waiting", "The shared EntryPoint was used, but that alone does not prove this transaction belongs to Loom."];
  if (classification === "unrelated") return ["Not a Loom execution", "error", "The available call trace did not touch this deployment or a verified Loom account runtime."];
  return ["Evidence incomplete", "waiting", "The selected RPC could not provide enough evidence to classify this transaction."];
}

function renderArchitectureTransactionDock(deployment) {
  const toggle = $("#architecture-transaction-toggle");
  const dock = $("#architecture-transaction-dock");
  const enabled = state.deploymentSource === "sepolia";
  toggle.hidden = !enabled;
  toggle.setAttribute("aria-pressed", String(enabled && state.architectureTransactionOpen));
  if (!enabled || !state.architectureTransactionOpen) {
    dock.hidden = true;
    dock.replaceChildren();
    return;
  }
  const busy = state.executionStatus === "confirming";
  const result = state.executionResult?.kind === "transaction-analysis" ? state.executionResult : null;
  const journey = buildTransactionArchitectureJourney(deployment, result);
  const [title, tone, description] = transactionClassification(result);
  const error = state.executionError ? `<p class="architecture-transaction-error" role="alert">${escapeHtml(state.executionError)}</p>` : "";
  const stages = result ? `<div class="architecture-transaction-stages" aria-label="Observed transaction path">${journey.stages.map((stage, index) => {
    const content = `<span>${index + 1}</span><div><strong>${escapeHtml(stage.label)}</strong>${stage.address ? `<code>${escapeHtml(short(stage.address, 10, 8))}</code>` : ""}<small>${escapeHtml(stage.description)}</small></div>`;
    return stage.contractId ? `<button type="button" class="${escapeHtml(stage.tone ?? "observed")}" data-transaction-contract="${escapeHtml(stage.contractId)}">${content}</button>` : `<article class="${escapeHtml(stage.tone ?? "observed")}">${content}</article>`;
  }).join("")}</div>` : "";
  const evidence = result ? `<div class="architecture-transaction-evidence"><span>${escapeHtml(formatTraceNumber(result.gasUsed))} gas</span><span>${escapeHtml(result.traceSummary?.calls ?? "No")} call frames</span><span>${escapeHtml(result.capabilities?.stateDiff ?? "state unavailable")}</span><span>${escapeHtml(result.capabilities?.opcodeTrace ?? "opcodes unavailable")}</span></div>` : "";
  dock.hidden = false;
  dock.innerHTML = `<header><div><p class="eyebrow">LIVE TRANSACTION PATH</p><h2>${escapeHtml(result ? title : "Trace a Sepolia wallet operation")}</h2><p>${escapeHtml(result ? description : "Paste a mined transaction hash. Wallet Lab verifies the selected deployment before mapping publisher, EntryPoint, account authority, policy, target calls, state effects, and receipt.")}</p></div>${result ? `<span class="status ${tone}">${escapeHtml(titleCase(journey.classification))}</span>` : ""}<button type="button" data-transaction-close aria-label="Close transaction trace">×</button></header><div class="architecture-transaction-form"><label><span>Sepolia transaction hash</span><input id="architecture-transaction-hash" value="${escapeHtml(state.executionTransactionHash)}" placeholder="0x…" spellcheck="false" /></label><button type="button" id="architecture-analyze-transaction"${busy || !state.executionTransactionHash ? " disabled" : ""}>${busy ? "Collecting evidence…" : "Analyze on chain"}</button></div>${error}${result ? `<div class="architecture-transaction-summary"><code>${escapeHtml(result.transactionHash)}</code><span>Block ${escapeHtml(formatTraceNumber(result.blockNumber))}</span></div>${evidence}${stages}<div class="architecture-transaction-actions"><button type="button" data-open-evm-evidence>Open state and opcode evidence</button></div><p class="architecture-transaction-note">Green stages are receipt- or trace-bound. Amber stages are shared infrastructure or calls outside the selected deployment. Missing debug methods remain unavailable; Wallet Lab does not reconstruct them from guesses.</p>` : `<p class="architecture-transaction-note">The transaction sender is shown as publisher / bundler executor. Its address proves who paid transaction gas, not which commercial bundler service operated it.</p>`}`;
}

function renderDeploymentGraph(deployment) {
  const root = $("#deployment-graph");
  if (!deployment?.nodes?.length) {
    root.className = "deployment-graph empty";
    root.textContent = "No deployment evidence is available yet.";
    return;
  }
  root.className = "deployment-graph";
  const view = architectureView(deployment);
  const groupDock = $("#architecture-expanded-groups");
  groupDock.innerHTML = view.groups.filter(group => group.expanded).map(group => `<button type="button" data-collapse-group="${escapeHtml(group.id)}"><span>${escapeHtml(group.label)}</span><strong>${group.count}</strong><b aria-hidden="true">×</b></button>`).join("");
  groupDock.hidden = !groupDock.childElementCount;
  if (state.focusedNodeId && !view.visibleNodes.some(node => node.id === state.focusedNodeId)) {
    state.focusedNodeId = null;
    state.focusedSection = null;
    state.focusedAbiItem = null;
  }
  const { positions, bounds, width: graphWidth, height, neighborIds, lanes } = graphPositions(view.visibleNodes, view.visibleEdges);
  const functionLens = selectedFunctionLens(deployment);
  const traceOverlay = observedTraceOverlay(deployment, currentTrace(state.artifact?.events ?? []));
  const overlay = functionLens?.status === "observed"
    ? { nodeIds: new Set(functionLens.observedNodeIds), edges: functionLens.observedEdges.map(edge => ({ ...edge, count: 1 })) }
    : traceOverlay;
  const functionObservedIds = new Set(functionLens?.observedNodeIds ?? []);
  const functionPossibleIds = new Set(functionLens?.possibleNodeIds ?? []);
  const edges = view.visibleEdges.map(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) return "";
    const fromBounds = bounds[edge.from];
    const toBounds = bounds[edge.to];
    const x1 = to.x >= from.x ? fromBounds.x + fromBounds.width : fromBounds.x;
    const x2 = to.x >= from.x ? toBounds.x : toBounds.x + toBounds.width;
    const mid = (x1 + x2) / 2;
    const edgeId = architectureEdgeId(edge);
    const selected = edgeId === state.focusedEdgeId ? " selected" : "";
    const lensPossible = functionLens && (edge.from === state.focusedNodeId || edge.to === state.focusedNodeId) ? " function-possible" : "";
    const faded = functionLens
      ? lensPossible ? "" : " unrelated"
      : state.focusedNodeId && edge.from !== state.focusedNodeId && edge.to !== state.focusedNodeId ? " unrelated" : "";
    const label = edge.kind === "delegates" ? "DELEGATECALL · shared code / instance state" : edge.label;
    const displayLabel = label.length > 30 ? `${label.slice(0, 29)}…` : label;
    return `<g class="graph-edge ${edgeClass(edge.kind)}${selected}${lensPossible}${faded}" data-edge-id="${escapeHtml(edgeId)}" role="button" tabindex="0" aria-label="Inspect relationship ${escapeHtml(label)}"><title>${escapeHtml(label)}</title><path d="M ${x1} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${x2} ${to.y}" marker-end="url(#arrow-${edgeClass(edge.kind)})"></path><text x="${mid}" y="${(from.y + to.y) / 2 - 8}" text-anchor="middle">${escapeHtml(displayLabel)}</text></g>`;
  }).join("");
  const observedEdges = overlay.edges.map(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) return "";
    const fromBounds = bounds[edge.from];
    const toBounds = bounds[edge.to];
    const x1 = to.x >= from.x ? fromBounds.x + fromBounds.width : fromBounds.x;
    const x2 = to.x >= from.x ? toBounds.x : toBounds.x + toBounds.width;
    const mid = (x1 + x2) / 2;
    const label = functionLens ? `${edge.type} · OBSERVED` : `${edge.type} · ${edge.count}×`;
    return `<g class="graph-edge observed${functionLens ? " function-observed" : ""}"><title>${escapeHtml(`${edge.type} observed ${edge.count} time${edge.count === 1 ? "" : "s"}`)}</title><path d="M ${x1} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${x2} ${to.y}" marker-end="url(#arrow-observed)"></path>${functionLens ? `<text x="${mid}" y="${(from.y + to.y) / 2 - 10}" text-anchor="middle">${escapeHtml(label)}</text>` : ""}</g>`;
  }).join("");
  const nodes = view.visibleNodes.map(node => {
    const point = positions[node.id];
    const nodeBounds = bounds[node.id];
    if (node.id === state.focusedNodeId) return renderFocusedArchitectureNode(deployment, node, nodeBounds, functionLens);
    const selected = node.id === state.focusedNodeId ? " selected" : "";
    const role = ({ core: "CORE", "transport-required": "ERC-4337 TRANSPORT", "deployment-required": "DEPLOYMENT REQUIRED", "profile-required": "ACTIVE PROFILE", optional: "OPTIONAL MODULE", "test-only": "LAB ONLY" })[node.requirement] ?? titleCase(node.requirement);
    const verification = node.verification ? ` · ${node.verification.toUpperCase()}` : "";
    const identityClass = node.id === "LoomAccount" ? " implementation" : node.id === "ObservedAccount" ? " instance" : "";
    const displayName = node.name.length > 28 ? `${node.name.slice(0, 27)}…` : node.name;
    const traceClass = functionLens
      ? functionObservedIds.has(node.id) ? " function-observed" : functionPossibleIds.has(node.id) ? " function-possible" : " function-idle"
      : state.traceOverlayEnabled ? overlay.nodeIds.has(node.id) ? " trace-observed" : " trace-idle" : "";
    const unrelated = functionLens
      ? !functionObservedIds.has(node.id) && !functionPossibleIds.has(node.id) ? " unrelated" : ""
      : state.focusedNodeId && !neighborIds.has(node.id) ? " unrelated" : "";
    if (node.nodeType === "group") return `<g class="graph-node architecture-group${unrelated}" data-architecture-group="${escapeHtml(node.id)}" role="button" tabindex="0" aria-label="Expand ${escapeHtml(node.name)} group with ${node.count} contracts"><rect x="${nodeBounds.x}" y="${nodeBounds.y}" width="${nodeBounds.width}" height="${nodeBounds.height}" rx="18"></rect><text class="node-kind" x="${nodeBounds.x + 20}" y="${point.y - 5}">OPTIONAL GROUP · ${node.count}</text><text class="node-name" x="${nodeBounds.x + 20}" y="${point.y + 18}">${escapeHtml(displayName)}</text><text class="group-open" x="${nodeBounds.x + nodeBounds.width - 25}" y="${point.y + 7}">+</text></g>`;
    const availability = node.availability === "source-only" ? " source-only" : "";
    const identity = node.address ? short(node.address, 10, 8) : "SOURCE ONLY · NOT DEPLOYED";
    return `<g class="graph-node ${escapeHtml(node.kind)} ${escapeHtml(node.requirement ?? "optional")}${availability}${identityClass}${selected}${traceClass}${unrelated}" data-contract-id="${escapeHtml(node.id)}" role="button" tabindex="0" aria-pressed="${node.id === state.focusedNodeId}" aria-label="Inspect ${escapeHtml(node.name)}"><rect x="${nodeBounds.x}" y="${nodeBounds.y}" width="${nodeBounds.width}" height="${nodeBounds.height}" rx="12"></rect><text class="node-kind" x="${nodeBounds.x + 20}" y="${point.y - 12}">${escapeHtml(role + verification)}</text><text class="node-name" x="${nodeBounds.x + 20}" y="${point.y + 10}">${escapeHtml(displayName)}</text><text class="node-address" x="${nodeBounds.x + 20}" y="${point.y + 29}">${escapeHtml(identity)}</text></g>`;
  }).join("");
  const laneMarks = lanes.map(lane => `<g class="architecture-group-lane" aria-hidden="true"><text x="${lane.xStart}" y="${lane.top + 18}">OPTIONAL GROUP · ${escapeHtml(lane.label)} · ${lane.count}</text><path d="M ${lane.xStart} ${lane.top + 30} H ${lane.xEnd}"/></g>`).join("");
  const transform = state.graphTransform;
  const zoomClass = transform.scale < .8 ? "zoom-far" : transform.scale > 1.2 ? "zoom-near" : "zoom-normal";
  root.innerHTML = `<svg viewBox="0 0 ${graphWidth} ${height}" role="img" aria-label="Loom deployment contract relationship graph"><defs><marker id="arrow-authority" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-call" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-create" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-observed" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs><g class="graph-stage ${zoomClass}" transform="translate(${transform.x} ${transform.y}) scale(${transform.scale})">${laneMarks}${edges}${observedEdges}${nodes}</g></svg>`;
  $("#graph-zoom-level").textContent = `${Math.round(transform.scale * 100)}%`;
  const overlayButton = $("#trace-overlay-toggle");
  const hasTrace = Boolean(currentTrace(state.artifact?.events ?? [])?.trace);
  overlayButton.disabled = !hasTrace;
  overlayButton.setAttribute("aria-pressed", String(state.traceOverlayEnabled && hasTrace));
  overlayButton.textContent = hasTrace ? state.traceOverlayEnabled ? "Hide observed trace" : "Show observed trace" : "Trace unavailable";
  renderArchitectureTransactionDock(deployment);
}

function graphPointerPosition(event) {
  const svg = $("#deployment-graph svg");
  if (!svg) return null;
  const bounds = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * viewBox.width,
    y: ((event.clientY - bounds.top) / bounds.height) * viewBox.height
  };
}

function focusArchitectureNode(contractId) {
  if (!contractId) return;
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const containingGroup = architectureView(deployment).groups.find(group => group.members.some(node => node.id === contractId));
  if (containingGroup) state.expandedArchitectureGroups = [...new Set([...state.expandedArchitectureGroups, containingGroup.id])];
  state.selectedContractId = contractId;
  state.selectedFunctionSelector = null;
  Object.assign(state, reduceArchitectureFocus(state, { type: "focus-node", nodeId: contractId }));
  state.focusedEdgeId = null;
  state.functionValues = {};
  resetExecutionState();
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
  $("#architecture-live").textContent = `${currentDeployment(state.artifact?.events ?? [])?.nodes.find(node => node.id === contractId)?.name ?? contractId} expanded.`;
}

function beginGraphInteraction(event) {
  if (event.button !== 0) return;
  if (event.target.closest("button, a, input, nav, .focus-content")) return;
  if (event.target.closest("[data-edge-id], [data-architecture-group]")) return;
  const point = graphPointerPosition(event);
  if (!point) return;
  const node = event.target.closest("[data-contract-id]");
  const origin = node ? state.graphNodeOffsets[node.dataset.contractId] ?? { x: 0, y: 0 } : state.graphTransform;
  state.graphInteraction = { type: node ? "node" : "pan", nodeId: node?.dataset.contractId ?? null, pointerId: event.pointerId, start: point, origin: { ...origin }, moved: false };
  $("#deployment-graph").setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveGraphInteraction(event) {
  const interaction = state.graphInteraction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  const point = graphPointerPosition(event);
  if (!point) return;
  const dx = point.x - interaction.start.x;
  const dy = point.y - interaction.start.y;
  interaction.moved ||= Math.hypot(dx, dy) > 3;
  if (interaction.type === "node") {
    state.graphNodeOffsets[interaction.nodeId] = { x: interaction.origin.x + dx / state.graphTransform.scale, y: interaction.origin.y + dy / state.graphTransform.scale };
  } else {
    state.graphTransform.x = interaction.origin.x + dx;
    state.graphTransform.y = interaction.origin.y + dy;
  }
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
}

function endGraphInteraction(event) {
  if (!state.graphInteraction || state.graphInteraction.pointerId !== event.pointerId) return;
  const interaction = state.graphInteraction;
  const moved = interaction.moved;
  const selectedNode = !moved && interaction.type === "node";
  state.ignoreGraphClick = moved || selectedNode;
  state.graphInteraction = null;
  $("#deployment-graph").releasePointerCapture?.(event.pointerId);
  if (selectedNode) focusArchitectureNode(interaction.nodeId);
  if (state.ignoreGraphClick) setTimeout(() => { state.ignoreGraphClick = false; }, 0);
}

function resetGraphView() {
  state.graphTransform = { x: 0, y: 0, scale: 1 };
  state.graphNodeOffsets = {};
  state.expandedArchitectureGroups = [];
  state.architectureSearch = "";
  state.focusedEdgeId = null;
  $("#architecture-search").value = "";
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
}

function setGraphZoom(nextScale, focalPoint = null) {
  state.graphTransform = zoomTransformAtPoint(state.graphTransform, nextScale, focalPoint);
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
}

function changeGraphZoom(delta) {
  setGraphZoom(state.graphTransform.scale + delta);
}

function zoomArchitectureWithWheel(event) {
  if (event.deltaY === 0) return;
  const focalPoint = graphPointerPosition(event);
  if (!focalPoint) return;
  event.preventDefault();
  setGraphZoom(state.graphTransform.scale * (event.deltaY < 0 ? 1.1 : .9), focalPoint);
}

function renderRelationshipSummary(deployment, contract) {
  const root = $("#relationship-summary");
  if (!root) return;
  if (!deployment || !contract) {
    root.className = "relationship-summary empty";
    root.textContent = "Select a contract to list its architectural relationships.";
    return;
  }
  const related = deployment.edges.filter(edge => edge.from === contract.id || edge.to === contract.id);
  root.className = "relationship-summary";
  root.innerHTML = `<strong>${escapeHtml(contract.name)} relationships</strong>${related.length ? related.map(edge => {
    const outgoing = edge.from === contract.id;
    const otherId = outgoing ? edge.to : edge.from;
    const other = deployment.nodes.find(node => node.id === otherId);
    return `<button type="button" data-contract-id="${escapeHtml(otherId)}"><span>${outgoing ? "to" : "from"}</span><strong>${escapeHtml(other?.name ?? otherId)}</strong><small>${escapeHtml(edge.label)}</small></button>`;
  }).join("") : `<span class="empty">No explicit architectural edge is cataloged.</span>`}`;
}

function selectedContract(deployment) {
  return deployment?.nodes?.find(node => node.id === state.selectedContractId) ?? deployment?.nodes?.find(node => node.kind === "account") ?? deployment?.nodes?.[0] ?? null;
}

function selectedFunction(contract) {
  return contract?.functions?.find(fn => fn.selector === state.selectedFunctionSelector) ?? contract?.functions?.[0] ?? null;
}

const requirementDescriptions = {
  core: "Required in every Loom account deployment. This contract is part of the account authority or deterministic creation boundary.",
  "transport-required": "Required for this ERC-4337 route, but it does not own the account. Direct sovereign publication remains a separate path.",
  "deployment-required": "Published and code-hash verified by every supported Loom deployment. Individual accounts still install and configure their own recovery authority.",
  "profile-required": "Required by the selected account security profile. Another valid Loom profile may install a different module.",
  optional: "Optional capability. It affects an account only after that account installs or configures it.",
  "test-only": "Local test evidence only. It is not a production Loom deployment dependency."
};

const layerDescriptions = {
  deployment: "Creates deterministic account instances and defines their initial configuration boundary.",
  "loom-core": "Implements the wallet's validation, module, and execution authority boundary.",
  "account-instance": "Holds one wallet's balances, nonce, modules, and storage while delegating shared logic.",
  "erc-4337-transport": "Routes UserOperations through the ERC-4337 validation and gas-settlement path.",
  authentication: "Verifies a configured signer or passkey before account authority can be exercised.",
  "execution-policy": "Applies constraints before and after account execution.",
  "asset-policy": "Applies optional asset-specific withdrawal and spending rules.",
  session: "Provides optional, bounded authority for a constrained session.",
  recovery: "Provides the deployment's delayed guardian recovery and validator replacement infrastructure. Account-level guardian configuration remains explicit.",
  "guardian-verifier": "Verifies one supported guardian proof format without changing account authority itself.",
  scenario: "Exists only to make the local laboratory state transition observable.",
  external: "Participates in the selected deployment but is outside Loom's cataloged core layers."
};

function githubSourceUrl(source) {
  if (source?.upstream?.repository && source.upstream.revision && source.upstream.path) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(source.upstream.repository) || !/^[a-zA-Z0-9_.-]+$/u.test(source.upstream.revision) || source.upstream.path.split("/").includes("..") || !/^[a-zA-Z0-9_./-]+$/u.test(source.upstream.path)) return null;
    const upstreamPath = source.upstream.path.split("/").map(encodeURIComponent).join("/");
    const upstreamLine = Number.isSafeInteger(source.declarationLine) && source.declarationLine > 0 ? `#L${source.declarationLine}` : "";
    return `https://github.com/${source.upstream.repository}/blob/${source.upstream.revision}/${upstreamPath}${upstreamLine}`;
  }
  if (!source?.path || source.path.split("/").includes("..") || !/^[a-zA-Z0-9_./-]+$/u.test(source.path)) return null;
  const commit = state.artifact?.environment?.gitCommit;
  const revision = /^[0-9a-f]{40}$/iu.test(commit ?? "") ? commit : "main";
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  const line = Number.isSafeInteger(source.declarationLine) && source.declarationLine > 0 ? `#L${source.declarationLine}` : "";
  return `https://github.com/emirongrr/loom/blob/${revision}/${path}${line}`;
}

function explorerAddressUrl(address) {
  if (!/^0x[0-9a-f]{40}$/iu.test(address ?? "")) return null;
  const chainId = state.deploymentSource === "sepolia" ? state.sepoliaDeployment?.chainId : state.artifact?.environment?.chainId;
  if (Number(chainId) === 11155111) return `https://eth-sepolia.blockscout.com/address/${address}`;
  return null;
}

function renderContractAddress(contract) {
  if (!contract.address) {
    return `<div class="contract-address-local source-only"><code>Not deployed in this run</code><span>Compiler-derived source catalog · no on-chain address claimed</span></div>`;
  }
  const explorerUrl = explorerAddressUrl(contract.address);
  if (explorerUrl) {
    return `<a class="contract-address-link" href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer" aria-label="View ${escapeHtml(contract.name)} on Sepolia Blockscout"><code>${escapeHtml(contract.address)}</code><span>View on Sepolia Blockscout <b aria-hidden="true">↗</b></span></a>`;
  }
  return `<div class="contract-address-local"><code>${escapeHtml(contract.address)}</code><span>Local chain address · no public explorer</span></div>`;
}

function renderDossierFacts(contract) {
  const sourceUrl = githubSourceUrl(contract.source);
  const sourcePath = contract.source?.upstream?.path ?? contract.source?.path;
  const sourceLocation = contract.source ? `${sourcePath}${contract.source.declarationLine ? `:${contract.source.declarationLine}` : ""}` : "Source artifact unavailable";
  const sourceExplanation = contract.source?.upstream
    ? `${contract.source.contractName} comes from the official ${contract.source.upstream.repository} ${contract.source.upstream.revision} source. Loom compiles a vendored copy at ${contract.source.path}.`
    : contract.source
    ? `${contract.source.contractName} compiled with Solidity ${contract.source.compilerVersion ?? "version not recorded"}. Repository path pinned to the commit recorded by this run.`
    : "Wallet Lab will not guess a source file without compiler evidence.";
  const sourceLinkLabel = contract.source?.upstream ? "Open official source on GitHub" : "Open source on GitHub";
  return `<details class="dossier-metadata"><summary><span>Contract metadata</span><small>Layer · source · ABI</small></summary><div class="dossier-facts"><div class="dossier-fact"><span>Layer</span><strong>${escapeHtml(titleCase(contract.layer ?? "external"))}</strong><p>${escapeHtml(layerDescriptions[contract.layer] ?? layerDescriptions.external)}</p></div><div class="dossier-fact source"><span>Source location</span><code>${escapeHtml(sourceLocation)}</code><p>${escapeHtml(sourceExplanation)}</p>${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceLinkLabel)}</a>` : ""}</div><div class="dossier-fact abi"><span>ABI surface</span><strong>${contract.functions.length} functions · ${(contract.events ?? []).length} events · ${(contract.errors ?? []).length} errors</strong><p>The callable functions and emitted or reverted interface decoded from the compiler artifact.</p></div></div></details>`;
}

function renderFieldCard(item, className) {
  const resolved = item.resolvedValue ? `<div class="field-value resolved"><span>Resolved value</span><code>${escapeHtml(item.resolvedValue)}</code></div>` : "";
  const expression = item.value ? `<div class="field-value expression"><span>Declared expression</span><code>${escapeHtml(item.value)}</code></div>` : item.getter ? `<div class="field-value expression"><span>Public getter</span><code>${escapeHtml(item.getter)}</code></div>` : "";
  return `<article class="${className}"><header><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.category)}</span><span>${escapeHtml(item.visibility)}</span></header><div class="field-type"><span>Type</span><code>${escapeHtml(item.type)}</code></div>${resolved}${expression}<p><b>Why it exists</b>${escapeHtml(item.purpose ?? item.documentation ?? "This field supports the contract's declared state model.")}</p></article>`;
}

function renderContractDossier(deployment, contract) {
  const root = $("#contract-dossier");
  if (!contract) {
    root.className = "surface contract-dossier empty";
    root.textContent = "Select a topology node to inspect its role, fields, and relationships.";
    return;
  }
  root.className = `surface contract-dossier ${escapeHtml(contract.requirement ?? "optional")}`;
  const related = deployment.edges.filter(edge => edge.from === contract.id || edge.to === contract.id);
  const relationships = related.map(edge => {
    const outgoing = edge.from === contract.id;
    const otherId = outgoing ? edge.to : edge.from;
    const other = deployment.nodes.find(node => node.id === otherId);
    return `<button type="button" class="dossier-relation" data-contract-id="${escapeHtml(otherId)}"><span>${outgoing ? "CALLS / USES" : "CALLED / USED BY"}</span><strong>${escapeHtml(other?.name ?? otherId)}</strong><small>${escapeHtml(edge.label)}</small></button>`;
  }).join("");
  root.innerHTML = `<div class="dossier-hero"><div><p class="eyebrow">SELECTED CONTRACT</p><h2>${escapeHtml(contract.name)}</h2>${renderContractAddress(contract)}</div><span class="requirement ${escapeHtml(contract.requirement ?? "optional")}">${escapeHtml(titleCase(contract.requirement ?? "optional"))}</span></div><p class="dossier-responsibility">${escapeHtml(contract.responsibility ?? "Deployment contract")}</p><div class="dossier-requirement"><strong>Deployment role</strong><p>${escapeHtml(requirementDescriptions[contract.requirement] ?? "This node is declared by the selected deployment evidence.")}</p></div>${renderDossierFacts(contract)}<section class="dossier-section"><div class="dossier-title"><strong>Contract relationships</strong><span>${related.length}</span></div>${relationships || `<p class="empty">No explicit architectural relationship is cataloged.</p>`}</section>`;
}

function abiFunctionRows(functions) {
  return functions.map(fn => `<button type="button" class="function-item${fn.selector === state.selectedFunctionSelector ? " selected" : ""}" data-function-selector="${escapeHtml(fn.selector)}"><span><strong>${escapeHtml(fn.name)}</strong><code>${escapeHtml(fn.signature)}</code><small class="function-purpose">${escapeHtml(fn.purpose ?? fn.behavior)}</small></span><span class="mutability ${escapeHtml(fn.stateMutability)}">${escapeHtml(fn.stateMutability)}</span></button>`).join("");
}

function renderAbiGroups(contract) {
  const root = $("#abi-groups");
  if (!contract) {
    root.className = "abi-groups empty";
    root.textContent = "Select a contract.";
    return;
  }
  $("#contract-heading").innerHTML = `<div><p class="eyebrow">ABI SURFACE</p><h2>${escapeHtml(contract.name)}</h2><code>${escapeHtml(short(contract.address, 10, 8))}</code></div><span>${escapeHtml(contract.functions.length + (contract.events ?? []).length + (contract.errors ?? []).length)} entries</span>`;
  const query = state.functionSearch.toLowerCase();
  const matches = value => !query || value.toLowerCase().includes(query);
  const readFunctions = contract.functions.filter(fn => ["view", "pure"].includes(fn.stateMutability) && matches(`${fn.signature} ${fn.selector} ${fn.purpose ?? ""}`));
  const writeFunctions = contract.functions.filter(fn => !["view", "pure"].includes(fn.stateMutability) && matches(`${fn.signature} ${fn.selector} ${fn.purpose ?? ""}`));
  const constants = (contract.fields ?? []).filter(item => item.category === "constant" && matches(`${item.name} ${item.type} ${item.value ?? ""} ${item.purpose ?? ""}`));
  const fields = (contract.fields ?? []).filter(item => item.category !== "constant" && matches(`${item.name} ${item.type} ${item.value ?? ""} ${item.purpose ?? ""}`));
  const events = (contract.events ?? []).filter(item => matches(`${item.signature} ${item.topic}`));
  const errors = (contract.errors ?? []).filter(item => matches(`${item.signature} ${item.selector}`));
  const fieldRows = items => items.map(item => renderFieldCard(item, "abi-value")).join("");
  const eventRows = events.map(item => `<article class="abi-declaration event"><strong>event ${escapeHtml(item.signature)}</strong><code>${escapeHtml(short(item.topic, 14, 10))}</code><small>${escapeHtml(item.inputs.filter(input => input.indexed).length)} indexed parameter(s)</small></article>`).join("");
  const errorRows = errors.map(item => `<article class="abi-declaration error"><strong>error ${escapeHtml(item.signature)}</strong><code>${escapeHtml(item.selector)}</code></article>`).join("");
  const group = (label, count, content, open = false) => `<details class="abi-group"${open ? " open" : ""}><summary><span>${escapeHtml(label)}</span><strong>${count}</strong></summary><div>${content || `<p class="empty">No matching entries.</p>`}</div></details>`;
  root.className = "abi-groups";
  root.innerHTML = group("Constants", constants.length, fieldRows(constants), true) + group("Storage & immutable fields", fields.length, fieldRows(fields)) + group("Read functions", readFunctions.length, abiFunctionRows(readFunctions), true) + group("Write functions", writeFunctions.length, abiFunctionRows(writeFunctions), true) + group("Events", events.length, eventRows) + group("Errors", errors.length, errorRows);
}

function validateArgument(type, value) {
  if (!value) return { status: "waiting", text: "Enter a value to preview this argument." };
  if (type === "address") return /^0x[0-9a-fA-F]{40}$/u.test(value) ? { status: "success", text: "20-byte address shape is valid." } : { status: "error", text: "Expected a 20-byte 0x-prefixed address." };
  if (/^u?int\d*$/u.test(type)) return /^-?\d+$/u.test(value) && (!type.startsWith("uint") || !value.startsWith("-")) ? { status: "success", text: "Integer text can be ABI encoded after range validation." } : { status: "error", text: `Expected ${type.startsWith("uint") ? "an unsigned" : "a signed"} base-10 integer.` };
  if (type === "bool") return ["true", "false"].includes(value) ? { status: "success", text: "Boolean value is valid." } : { status: "error", text: "Use true or false." };
  if (/^bytes(\d+)?$/u.test(type)) return /^0x(?:[0-9a-fA-F]{2})*$/u.test(value) ? { status: "success", text: "Hex byte shape is valid; fixed-length bounds still apply." } : { status: "error", text: "Expected even-length 0x-prefixed hex bytes." };
  if (type.endsWith("]") || type.startsWith("(")) {
    try { JSON.parse(value); return { status: "success", text: "Structured JSON parsed; ABI tuple/array shape must still match each component." }; } catch { return { status: "error", text: "Enter arrays and tuples as valid JSON." }; }
  }
  return { status: "waiting", text: "Value will be interpreted according to the ABI type." };
}

function flattenTrace(node, result = []) {
  if (!node) return result;
  result.push(node);
  for (const child of node.calls ?? []) flattenTrace(child, result);
  return result;
}

function behaviorSteps(fn, contract, tracePayload) {
  const observed = flattenTrace(tracePayload?.trace).filter(call => call.contractId === contract.id && call.selector === fn.selector);
  const steps = [
    { title: "ABI routing", text: `The EVM reads selector ${fn.selector} and dispatches to ${fn.signature}.`, status: "neutral" },
    { title: "Calldata decoding", text: `${fn.inputs.length} typed argument${fn.inputs.length === 1 ? " is" : "s are"} decoded before the Solidity function body runs. Invalid offsets, sizes, or scalar ranges revert.`, status: "neutral" }
  ];
  if (fn.stateMutability === "pure") steps.push({ title: "Execution mode", text: "Pure execution uses calldata and memory only; Solidity prevents storage reads and writes.", status: "success" });
  else if (fn.stateMutability === "view") steps.push({ title: "Execution mode", text: "Wallet Lab treats this as eth_call / STATICCALL. Any attempted state write reverts and no state is committed.", status: "success" });
  else if (fn.stateMutability === "payable") steps.push({ title: "Execution mode", text: "A signed transaction or UserOperation is required. msg.value is accepted, but policy and function checks may still revert.", status: "waiting" });
  else steps.push({ title: "Execution mode", text: "A signed transaction or UserOperation is required. Non-zero msg.value is rejected before normal function execution.", status: state.functionCallValue !== "0" ? "error" : "waiting" });
  steps.push(observed.length
    ? { title: "Observed in this run", text: `${observed.length} matching EVM frame${observed.length === 1 ? " was" : "s were"} captured. Select the frame below for gas, caller, output, and nested calls.`, status: "success" }
    : { title: "Observed in this run", text: "This function was not executed by the recorded transaction. The preview is ABI-derived, not a claim that the call would succeed on current state.", status: "neutral" });
  return steps;
}

function renderSourceExcerpt(contract, fn) {
  const source = contract.source;
  if (!source?.code) return `<section class="source-excerpt empty"><p>Verified source text is not available for this deployment node. ABI behavior remains visible, but Wallet Lab will not invent source provenance.</p></section>`;
  const lines = source.code.split(/\r?\n/u);
  const escapedName = fn.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matchIndex = fn.sourceRange
    ? source.code.slice(0, fn.sourceRange.start).split(/\r?\n/u).length - 1
    : lines.findIndex(line => new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`, "u").test(line));
  const start = Math.max(0, matchIndex < 0 ? 0 : matchIndex - 4);
  const end = Math.min(lines.length, matchIndex < 0 ? 30 : matchIndex + 28);
  const rendered = lines.slice(start, end).map((line, index) => `<span><i>${start + index + 1}</i><code>${escapeHtml(line) || " "}</code></span>`).join("");
  const note = matchIndex < 0
    ? "The exact declaration was not located; showing the beginning of the compiler-target source."
    : !fn.sourceRange ? "This older artifact lacks selector-bound AST ranges; the excerpt is matched by function name and may be ambiguous for overloads." : "";
  return `<section class="source-excerpt"><div class="source-heading"><div><p class="eyebrow">SOURCE CODE</p><h3>${escapeHtml(source.path)}</h3></div><span>${escapeHtml(source.language)} ${escapeHtml(source.compilerVersion ?? "")}</span></div><pre>${rendered}</pre>${note ? `<p class="evidence-note">${escapeHtml(note)}</p>` : ""}</section>`;
}

function renderFunctionInteractions(contract, fn, tracePayload) {
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const addressToNode = new Map((deployment?.nodes ?? []).filter(node => node.address).map(node => [node.address.toLowerCase(), node]));
  const relationships = (deployment?.edges ?? []).filter(edge => edge.from === contract.id || edge.to === contract.id).map(edge => {
    const outgoing = edge.from === contract.id;
    const otherId = outgoing ? edge.to : edge.from;
    const other = deployment.nodes.find(node => node.id === otherId);
    return `<article class="interaction-row architectural"><span>${outgoing ? "MAY CALL / USE" : "MAY BE CALLED / USED BY"}</span><strong>${escapeHtml(other?.name ?? otherId)}</strong><p>${escapeHtml(edge.label)}</p></article>`;
  });
  const observed = flattenTrace(tracePayload?.trace).filter(frame => frame.contractId === contract.id && frame.selector === fn.selector).flatMap(frame => {
    const caller = typeof frame.from === "string" ? addressToNode.get(frame.from.toLowerCase()) : null;
    const entry = `<article class="interaction-row observed"><span>OBSERVED CALLER</span><strong>${escapeHtml(caller?.name ?? short(frame.from, 10, 8))}</strong><p>${escapeHtml(frame.type ?? "CALL")} into ${escapeHtml(fn.signature)} · ${escapeHtml(formatTraceNumber(frame.gasUsed))} gas</p></article>`;
    const children = (frame.calls ?? []).map(child => `<article class="interaction-row observed"><span>OBSERVED NESTED CALL</span><strong>${escapeHtml(child.contractName ?? short(child.to, 10, 8))}</strong><p>${escapeHtml(child.functionSignature ?? child.selector ?? child.type ?? "CALL")}</p></article>`);
    return [entry, ...children];
  });
  return `<section class="function-interactions"><div class="section-title"><div><p class="eyebrow">INTERACTIONS</p><h3>Who reaches this contract, and what it reaches</h3></div></div><p class="interaction-note">Architecture rows describe contract-level possibilities. Green observed rows are exact frames from this run for the selected selector.</p><div class="interaction-groups"><div><strong>Architecture</strong>${relationships.join("") || `<p class="empty">No static relationship is cataloged.</p>`}</div><div><strong>Observed execution</strong>${observed.join("") || `<p class="empty">This function was not called in the recorded transaction.</p>`}</div></div></section>`;
}

function renderFunctionInspector(contract, fn, tracePayload) {
  const root = $("#function-inspector");
  if (!contract || !fn) {
    root.className = "surface function-inspector empty";
    root.textContent = "Select a function to inspect its parameters and EVM behavior.";
    return;
  }
  root.className = "surface function-inspector";
  const steps = behaviorSteps(fn, contract, tracePayload);
  root.innerHTML = `<div class="inspector-heading"><div><p class="eyebrow">FUNCTION BEHAVIOR</p><h2>${escapeHtml(fn.name)}</h2><code>${escapeHtml(fn.signature)}</code></div><span class="mutability ${escapeHtml(fn.stateMutability)}">${escapeHtml(fn.stateMutability)}</span></div><section class="function-purpose-detail"><strong>Why this function exists</strong><p>${escapeHtml(fn.purpose ?? fn.behavior)}</p></section><p class="lead">${escapeHtml(fn.behavior)}</p><div class="selector-line">${field("Contract", contract.address, { code: true, short: true })}${field("Selector", fn.selector, { code: true })}${field("Outputs", fn.outputs.length ? fn.outputs.map(output => output.type).join(", ") : "none", { code: true })}</div>${renderFunctionInteractions(contract, fn, tracePayload)}${renderSourceExcerpt(contract, fn)}<div class="behavior-flow">${steps.map((step, index) => `<article class="behavior-step ${step.status}"><span>${index + 1}</span><div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.text)}</p></div></article>`).join("")}</div><div class="call-shape"><span>Call shape</span><code>${escapeHtml(contract.address)} . ${escapeHtml(fn.selector)} + ABI.encode(${escapeHtml(fn.inputs.map(input => input.name || input.type).join(", "))})</code></div>`;
}

function renderExecutionCatalog(deployment, selected, selectedFn) {
  const root = $("#execution-contract-browser");
  if (!root) return;
  const contracts = deployment?.nodes ?? [];
  const query = state.executionSearch.trim().toLowerCase();
  const mode = state.executionFunctionMode;
  const visibleFunctions = contract => (contract.functions ?? []).filter(fn => {
    const modeMatch = mode === "all" || (mode === "read" ? ["view", "pure"].includes(fn.stateMutability) : !["view", "pure"].includes(fn.stateMutability));
    return modeMatch && (!query || `${contract.name} ${fn.name} ${fn.signature} ${fn.purpose ?? ""}`.toLowerCase().includes(query));
  });
  const rows = contracts.map(contract => {
    const functions = visibleFunctions(contract);
    if (query && !functions.length && !contract.name.toLowerCase().includes(query)) return "";
    const active = contract.id === selected?.id;
    return `<section class="execution-contract-group${active ? " selected" : ""}"><button type="button" class="execution-contract-choice" data-execution-contract="${escapeHtml(contract.id)}" aria-expanded="${active}"><span class="requirement-dot ${escapeHtml(contract.requirement)}"></span><span><strong>${escapeHtml(contract.name)}</strong><small>${escapeHtml(titleCase(contract.layer))} · ${escapeHtml(contract.functions?.length ?? 0)} functions</small></span><em>${escapeHtml(titleCase(contract.requirement))}</em></button>${active ? `<div class="execution-function-list">${functions.map(fn => `<button type="button" class="execution-function-choice${fn.selector === selectedFn?.selector ? " selected" : ""}" data-execution-function="${escapeHtml(fn.selector)}" aria-pressed="${fn.selector === selectedFn?.selector}"><span><strong>${escapeHtml(fn.name)}</strong><code>${escapeHtml(fn.signature)}</code></span><span class="mutability ${escapeHtml(fn.stateMutability)}">${escapeHtml(fn.stateMutability)}</span><small>${escapeHtml(fn.purpose ?? fn.behavior)}</small></button>`).join("") || `<p class="empty">No functions match this filter.</p>`}</div>` : ""}</section>`;
  }).join("");
  root.innerHTML = `<div class="execution-catalog-heading"><div><p class="eyebrow">DEPLOYMENT ABI</p><h2>Contracts and functions</h2><p>Choose the exact callable surface to simulate.</p></div><span>${escapeHtml(contracts.length)} contracts</span></div><label class="compact-search"><span>Find a function</span><input id="execution-search" type="search" value="${escapeHtml(state.executionSearch)}" placeholder="Contract, function, selector..." /></label><div class="execution-mode-filter" role="group" aria-label="Function type"><button type="button" data-execution-mode="all" aria-pressed="${mode === "all"}">All</button><button type="button" data-execution-mode="read" aria-pressed="${mode === "read"}">Read</button><button type="button" data-execution-mode="write" aria-pressed="${mode === "write"}">Write</button></div><div class="execution-contract-list">${rows || `<p class="empty">No deployment function matches this search.</p>`}</div>`;
}

function renderExecutionTrace(trace) {
  const frames = flattenTraceFrames(trace);
  if (!frames.length) return `<p class="empty">This RPC did not provide a call trace.</p>`;
  return `<ol class="execution-trace">${frames.map(frame => `<li style="--execution-depth:${Math.min(frame.depth, 7)}"><span class="trace-type ${escapeHtml(String(frame.type ?? "call").toLowerCase())}">${escapeHtml(frame.type ?? "CALL")}</span><div><strong>${escapeHtml(frame.contractName ?? short(frame.to, 10, 8))}</strong><code>${escapeHtml(traceLabel(frame))}</code></div><small>${escapeHtml(formatTraceNumber(frame.gasUsed))} gas</small><em class="${frame.error ? "error" : "success"}">${frame.error ? "reverted" : "returned"}</em></li>`).join("")}</ol>`;
}

function renderExecutionGraph(result) {
  const frames = flattenTraceFrames(result?.trace);
  if (!frames.length) return `<section class="execution-graph-panel"><div class="section-title"><div><p class="eyebrow">EXECUTION GRAPH</p><h2>Contract call movement</h2></div><span>Unavailable</span></div><p class="empty">This RPC did not expose call frames, so Wallet Lab will not infer a graph.</p></section>`;
  const maxDepth = Math.max(...frames.map(frame => frame.depth));
  const width = Math.max(760, 270 + maxDepth * 230);
  const height = Math.max(150, 38 + frames.length * 92);
  const rootGas = traceBigInt(frames[0]?.gasUsed);
  const changed = new Set((result.stateDiff?.accounts ?? []).filter(account => account.storage?.length || account.balance?.before !== account.balance?.after || account.nonce?.before !== account.nonce?.after).map(account => account.address?.toLowerCase()));
  const positions = new Map(frames.map((frame, index) => [frame.path, { x: 28 + frame.depth * 230, y: 24 + index * 92 }]));
  const edges = frames.slice(1).map(frame => {
    const child = positions.get(frame.path);
    const parent = positions.get(frame.path.split(".").slice(0, -1).join("."));
    if (!child || !parent) return "";
    const startX = parent.x + 188;
    const startY = parent.y + 31;
    const endX = child.x;
    const endY = child.y + 31;
    const bend = Math.max(28, (endX - startX) / 2);
    return `<path class="execution-graph-edge" d="M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}" marker-end="url(#execution-arrow)" />`;
  }).join("");
  const nodes = frames.map(frame => {
    const position = positions.get(frame.path);
    const gas = traceBigInt(frame.gasUsed);
    const gasShare = rootGas > 0n ? Math.max(3, Number((gas * 100n) / rootGas)) : 3;
    const writes = changed.has(frame.to?.toLowerCase());
    return `<g class="execution-graph-node${frame.error ? " error" : ""}${writes ? " writes" : ""}" transform="translate(${position.x} ${position.y})"><rect width="188" height="62" rx="9" /><rect class="gas-share" y="58" width="${Math.min(188, 1.88 * gasShare)}" height="4" rx="2" /><text class="node-type" x="12" y="16">${escapeHtml(frame.type ?? "CALL")} · depth ${escapeHtml(frame.depth)}</text><text class="node-contract" x="12" y="34">${escapeHtml(short(frame.contractName ?? frame.to, 20, 6))}</text><text class="node-function" x="12" y="50">${escapeHtml(short(traceLabel(frame), 22, 8))}</text>${writes ? `<text class="node-write" x="176" y="16" text-anchor="end">STATE</text>` : ""}<title>${escapeHtml(`${frame.contractName ?? frame.to} · ${traceLabel(frame)} · ${formatTraceNumber(frame.gasUsed)} gas${frame.error ? ` · ${frame.revertReason ?? frame.error}` : ""}`)}</title></g>`;
  }).join("");
  return `<section class="execution-graph-panel"><div class="section-title"><div><p class="eyebrow">EXECUTION GRAPH</p><h2>Contract call movement</h2><p>Every node is an observed EVM call frame. Horizontal position is call depth; the lower edge shows inclusive gas relative to the root.</p></div><div class="execution-graph-legend"><span class="call">Call frame</span><span class="writes">State touched</span><span class="error">Reverted</span></div></div><div class="execution-graph-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Observed contract execution graph"><defs><marker id="execution-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" /></marker></defs>${edges}${nodes}</svg></div></section>`;
}

function renderExecutionStateDiff(diff) {
  if (!diff?.accounts?.length) return `<p class="empty">No state changes were reported. The RPC may not expose prestate tracing, or the call did not write state.</p>`;
  return `<div class="execution-state-list">${diff.accounts.map(account => `<article><header><code>${escapeHtml(short(account.address, 12, 10))}</code><span>${account.storage.length} storage slot${account.storage.length === 1 ? "" : "s"}</span></header>${account.balance.before !== account.balance.after ? `<p><strong>Balance</strong><code>${escapeHtml(account.balance.before ?? "unchanged")}</code><i>→</i><code>${escapeHtml(account.balance.after ?? "unchanged")}</code></p>` : ""}${account.nonce.before !== account.nonce.after ? `<p><strong>Nonce</strong><code>${escapeHtml(account.nonce.before ?? "unchanged")}</code><i>→</i><code>${escapeHtml(account.nonce.after ?? "unchanged")}</code></p>` : ""}${account.storage.map(slot => `<p><strong title="${escapeHtml(slot.slot)}">${escapeHtml(short(slot.slot, 10, 8))}</strong><code>${escapeHtml(short(slot.before ?? "empty", 12, 10))}</code><i>→</i><code>${escapeHtml(short(slot.after ?? "empty", 12, 10))}</code></p>`).join("")}</article>`).join("")}${diff.truncated ? `<p class="evidence-note">The state diff exceeded the bounded display limit and was truncated.</p>` : ""}</div>`;
}

function renderExecutionTools(contract, busy) {
  if (state.deploymentSource === "sepolia") {
    return `<section class="execution-lab-tools"><div><p class="eyebrow">MINED TRANSACTION ANALYZER</p><h3>Prove whether a Sepolia transaction used Loom</h3><p>Paste any mined transaction hash. Wallet Lab verifies the chain and receipt, detects trusted deployment code and Loom account proxies, then requests call, state, log, and opcode evidence from the selected RPC.</p></div><div class="execution-import"><label><span>Sepolia transaction hash</span><input id="execution-transaction-hash" value="${escapeHtml(state.executionTransactionHash)}" placeholder="0x..." /></label><button type="button" id="inspect-sepolia"${busy || !state.executionTransactionHash ? " disabled" : ""}>Analyze transaction</button></div><p class="evidence-note">A shared EntryPoint call alone is not labeled as Loom. Positive provenance requires a verified Loom proxy runtime or observed trusted Loom deployment code. Public RPC presets may omit debug tracing; connect a trace-capable Sepolia RPC with <code>SEPOLIA_RPC_URL</code> or <code>--rpc-url</code> to add call, state, and opcode evidence.</p></section>`;
  }
  return `<section class="execution-lab-tools"><div><p class="eyebrow">LOCAL ABI COVERAGE</p><h3>Exercise the deployment without publishing state</h3><p>Deterministic type-safe inputs run every ABI entry point through <code>eth_call</code>. Successes, authorization reverts, decoded errors, and call frames remain separate evidence.</p></div><div class="execution-actions"><button type="button" id="probe-contract"${busy || !contract ? " disabled" : ""}>Probe ${escapeHtml(contract?.name ?? "selected contract")}</button><button type="button" id="probe-deployment" class="execution-primary"${busy ? " disabled" : ""}>Probe all deployment functions</button></div><p class="evidence-note">The matrix never calls <code>eth_sendTransaction</code>. Open a row for full simulation or an explicit local transaction.</p></section>`;
}

function renderProbeResult(result) {
  if (!result) return "";
  const rows = result.results ?? [];
  return `<section class="probe-result" aria-live="polite"><div class="section-title"><div><p class="eyebrow">ABI EXECUTION MATRIX</p><h3>${escapeHtml(result.attempted)} functions attempted</h3><p>Each row records the current local-state outcome; a revert is useful authorization or precondition evidence, not a skipped function.</p></div><span>No transactions published</span></div><div class="probe-metrics">${field("Returned", result.succeeded, { code: true })}${field("Reverted", result.reverted, { code: true })}${field("Input fixture needed", result.unsupported, { code: true })}${field("Network", networkLabel(result.chainId))}</div><div class="probe-table"><div class="probe-head"><span>Contract / function</span><span>Mode</span><span>Result</span><span>Trace</span></div>${rows.map(item => `<button type="button" class="probe-row" data-probe-contract="${escapeHtml(item.contract.id)}" data-probe-selector="${escapeHtml(item.function.selector)}"><span><strong>${escapeHtml(item.contract.name)}</strong><code>${escapeHtml(item.function.signature)}</code></span><span class="mutability ${escapeHtml(item.function.stateMutability)}">${escapeHtml(item.function.stateMutability)}</span><span class="status ${escapeHtml(statusClass(item.status))}">${escapeHtml(item.status)}</span><span>${escapeHtml(item.traceSummary ? `${item.traceSummary.calls} frames` : "trace unavailable")}</span></button>`).join("")}</div></section>`;
}

function renderTransactionProvenance(result) {
  if (!result?.provenance) return "";
  const provenance = result.provenance;
  const labels = {
    "loom-confirmed": ["Loom involvement verified", "The receipt is bound to this transaction and the evidence reached trusted Loom deployment code or a runtime-verified Loom account."],
    "erc4337-only": ["Only shared ERC-4337 transport observed", "The transaction reached EntryPoint, but available evidence does not prove that an included account is a Loom account."],
    unrelated: ["No Loom execution observed", "The available call trace does not touch this verified Loom deployment."],
    inconclusive: ["Loom provenance is inconclusive", "The RPC did not expose enough trace or account-runtime evidence to make a positive or negative claim."]
  };
  const [title, description] = labels[provenance.classification] ?? labels.inconclusive;
  return `<section class="transaction-provenance"><div class="section-title"><div><p class="eyebrow">LOOM PROVENANCE</p><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div><span class="status ${escapeHtml(statusClass(provenance.classification === "loom-confirmed" ? "success" : provenance.classification === "unrelated" ? "error" : "waiting"))}">${escapeHtml(titleCase(provenance.basis))}</span></div><div class="provenance-checks">${(provenance.checks ?? []).map(check => `<article class="${escapeHtml(check.status)}"><strong>${escapeHtml(check.label)}</strong><span>${escapeHtml(titleCase(check.status))}</span><code title="${escapeHtml(check.detail)}">${escapeHtml(short(check.detail, 18, 12))}</code></article>`).join("")}</div><div class="touched-contracts"><div class="section-title"><div><p class="eyebrow">TOUCHED ADDRESSES</p><h3>What the transaction called or logged</h3></div><span>${escapeHtml(result.touchedContracts?.length ?? 0)}</span></div>${(result.touchedContracts ?? []).map(item => `<article><span class="touch-role ${escapeHtml(item.role)}">${escapeHtml(item.role)}</span><div><strong>${escapeHtml(item.name)}</strong><code>${escapeHtml(item.address)}</code>${item.functions?.length ? `<small>${escapeHtml(item.functions.join(" · "))}</small>` : ""}</div><span>${escapeHtml(item.calls)} calls<br />${escapeHtml(item.logs)} logs</span></article>`).join("") || `<p class="empty">No address-level evidence was returned.</p>`}</div></section>`;
}

function renderExecutionJourney(result) {
  const reverted = result.status === "reverted";
  const stages = [
    ["Calldata", "ABI inputs encoded into the exact byte payload sent to the selected address.", "observed"],
    ["Dispatch", result.capabilities?.callTrace === "available" ? "The EVM resolved selectors and nested CALL, STATICCALL, or DELEGATECALL frames." : "The RPC did not expose call-frame evidence.", result.capabilities?.callTrace === "available" ? "observed" : "unavailable"],
    ["Opcodes", result.capabilities?.opcodeTrace === "available" ? `${result.opcodeProfile?.totalSteps ?? 0} VM instructions were executed and profiled.` : "The RPC did not expose instruction-level evidence.", result.capabilities?.opcodeTrace === "available" ? "observed" : "unavailable"],
    ["State", result.capabilities?.stateDiff === "available" ? "Balance, nonce, code, and bounded storage differences were compared." : "The RPC did not expose a pre/post state diff.", result.capabilities?.stateDiff === "available" ? "observed" : "unavailable"],
    [reverted ? "Revert" : "Return", reverted ? "Execution stopped and returned revert data; simulated state was discarded." : "The EVM returned output and the simulator discarded all hypothetical state.", reverted ? "reverted" : "observed"]
  ];
  return `<section class="execution-journey" aria-label="Execution evidence stages">${stages.map(([name, description, status], index) => `<article class="${status}"><span>${index + 1}</span><div><strong>${name}</strong><p>${escapeHtml(description)}</p></div><em>${status === "observed" ? "evidence" : status}</em></article>`).join("")}</section>`;
}

function opcodePurpose(opcode) {
  if (["CALL", "CALLCODE", "STATICCALL", "DELEGATECALL"].includes(opcode)) return "Moves execution into another contract context.";
  if (["CREATE", "CREATE2"].includes(opcode)) return "Creates contract bytecode at a new address.";
  if (["SLOAD", "TLOAD"].includes(opcode)) return "Reads persistent or transient contract state.";
  if (["SSTORE", "TSTORE"].includes(opcode)) return "Writes persistent or transient contract state.";
  if (["MLOAD", "CALLDATALOAD"].includes(opcode)) return "Reads temporary memory or calldata for this frame.";
  if (["MSTORE", "MSTORE8"].includes(opcode)) return "Writes temporary EVM memory for later instructions.";
  if (["JUMP", "JUMPI", "JUMPDEST"].includes(opcode)) return "Changes or marks the control-flow path.";
  if (["KECCAK256", "SHA3"].includes(opcode)) return "Hashes memory, commonly for storage keys or commitments.";
  if (opcode.startsWith("LOG")) return "Appends an event log to the transaction receipt.";
  if (opcode === "REVERT") return "Stops this frame, rolls back its writes, and returns error bytes.";
  if (["RETURN", "STOP"].includes(opcode)) return "Completes this frame and returns control to its caller.";
  if (opcode === "SELFDESTRUCT") return "Invokes the network-defined self-destruction behavior.";
  return "Executes one instruction in the current EVM frame.";
}

function renderExecutionResult(result) {
  if (!result) return "";
  const transaction = ["transaction", "transaction-analysis"].includes(result.kind);
  const events = result.events ?? [];
  const headline = result.status === "success"
    ? transaction ? "Transaction evidence collected" : "Call completed without committing state"
    : "Execution reverted";
  const explanation = transaction
    ? "This evidence is bound to a mined receipt, not a finality claim. Trace-dependent sections stay explicitly unavailable when the RPC does not expose them."
    : "eth_call and debug_traceCall evaluated the selected inputs at the latest block. No transaction was published and no state was committed.";
  const functionName = result.function?.signature ?? (result.kind === "transaction-analysis"
    ? (result.capabilities?.callTrace === "available" ? "See decoded call tree" : "Unavailable without call trace")
    : EMPTY);
  const output = result.kind === "transaction-analysis" ? "" : `<details open><summary>Decoded output</summary>${jsonBlock(result.output?.decoded ?? result.output?.raw ?? "No return value", "Execution output")}</details>`;
  const stateHeading = transaction ? "Observed state changes" : "Hypothetical state delta";
  const revert = result.revert ? `<div class="execution-revert"><strong>${escapeHtml(result.revert.name ?? "Execution reverted")}</strong><code>${escapeHtml(result.revert.data ?? "No revert data")}</code><p>The revert is part of the result and may identify a caller, EntryPoint, validator, timing, or policy precondition.</p></div>` : "";
  const receiptEvents = transaction
    ? `<section class="execution-events"><div class="section-title"><div><p class="eyebrow">EVENTS</p><h3>Receipt logs</h3></div><span>${events.length}</span></div>${events.length ? events.map(event => `<article><div><strong>${escapeHtml(event.name ?? "Unknown event")}</strong><code>${escapeHtml(event.contractId ?? short(event.address, 10, 8))}</code></div>${jsonBlock(event.args ?? { topics: event.topics, data: event.data }, "Decoded event")}</article>`).join("") : `<p class="empty">The transaction emitted no logs.</p>`}</section>`
    : "";
  return `<section class="execution-result" aria-live="polite"><div class="execution-result-heading"><div><p class="eyebrow">${transaction ? "MINED TRANSACTION" : "SIMULATION ONLY"}</p><h2>${escapeHtml(headline)}</h2><p>${escapeHtml(explanation)}</p></div><span class="status ${escapeHtml(statusClass(result.status))}">${escapeHtml(result.status)}</span></div><div class="execution-result-metrics">${field("Network", networkLabel(result.chainId))}${field(transaction ? "Transaction" : "Target", transaction ? result.transactionHash : result.contract?.address, { code: true, short: true })}${field("Function", functionName, { code: true })}${field("Gas used", transaction ? formatTraceNumber(result.gasUsed) : formatTraceNumber(result.trace?.gasUsed), { code: true })}${field("Call frames", result.traceSummary?.calls ?? "Unavailable", { code: true })}${field("Opcode steps", result.opcodeProfile?.totalSteps ?? "Unavailable", { code: true })}</div>${renderExecutionJourney(result)}${renderTransactionProvenance(result)}${revert}${renderExecutionGraph(result)}<div class="execution-result-grid"><section><div class="section-title"><div><p class="eyebrow">INPUT / OUTPUT</p><h3>Encoded call</h3></div></div>${field("Caller", result.transaction?.from ?? "RPC default caller", { code: true, short: true })}${field("Value (wei)", result.transaction?.value ?? "0x0", { code: true })}<details><summary>Calldata</summary>${jsonBlock(result.transaction?.input ?? result.transaction?.data ?? "0x", "Execution calldata")}</details>${output}</section><section><div class="section-title"><div><p class="eyebrow">CALL FRAME INDEX</p><h3>Observed calls</h3></div><span>${escapeHtml(result.capabilities?.callTrace ?? "unavailable")}</span></div>${renderExecutionTrace(result.trace)}</section></div><section class="execution-state-panel"><div class="section-title"><div><p class="eyebrow">STORAGE / BALANCE / NONCE</p><h3>${stateHeading}</h3><p>${transaction ? "Receipt-bound pre/post evidence from the selected RPC." : "The tracer evaluated these changes, then eth_call discarded them without altering the devnet."}</p></div><span>${escapeHtml(result.capabilities?.stateDiff ?? "unavailable")}</span></div>${renderExecutionStateDiff(result.stateDiff)}</section>${renderOpcodeExplorer(result.opcodeProfile)}${receiptEvents}<details class="execution-technical"><summary>Complete execution evidence</summary>${jsonBlock(result, "Execution evidence")}</details></section>`;
}

function executionExampleContext(deployment) {
  const nodes = deployment?.nodes ?? [];
  const byName = name => nodes.find(node => node.name === name)?.address;
  const observed = nodes.find(node => node.kind === "account" || node.layer === "account-instance")?.address;
  const target = byName("DevnetTarget") ?? observed ?? byName("LoomAccount");
  return {
    caller: state.functionCaller,
    chainId: state.deploymentSource === "sepolia" ? 11155111 : 31337,
    nowSeconds: state.exampleNowSeconds,
    addresses: {
      account: observed ?? byName("LoomAccount"),
      entryPoint: byName("EntryPoint"),
      validator: byName("P256Validator") ?? byName("ECDSAValidator"),
      recovery: byName("RecoveryManager"),
      factory: byName("LoomAccountFactory"),
      hook: byName("PolicyHook") ?? byName("VaultHook"),
      verifier: byName("P256GuardianVerifier") ?? byName("ECDSAGuardianVerifier"),
      target
    },
    targetSelector: nodes.find(node => node.name === "DevnetTarget")?.functions?.find(fn => fn.name === "setValue")?.selector
  };
}

function renderExecutionWorkspace(contract, fn, tracePayload) {
  const root = $("#execution-workspace");
  const busy = ["simulating", "broadcasting", "confirming", "probing"].includes(state.executionStatus);
  const networkName = state.deploymentSource === "sepolia" ? "Verified Sepolia" : "Local Anvil devnet";
  const tools = renderExecutionTools(contract, busy);
  if (!contract || !fn) {
    root.className = "surface execution-workspace";
    root.innerHTML = `<div class="execution-workspace-heading"><div><p class="eyebrow">EXECUTION WORKSPACE</p><h2>Run and explain Loom execution</h2><p>Analyze a complete mined transaction or exercise the deployment ABI before selecting one function for deep inspection.</p></div><span class="execution-selection"><strong>${escapeHtml(networkName)}</strong><small>Deployment-wide tools</small></span></div>${tools}<p class="empty">Select a contract function for exact calldata, full simulation, and explicit local execution.</p>${renderProbeResult(state.executionProbeResult)}${renderExecutionResult(state.executionResult)}`;
    return;
  }
  const exampleContext = executionExampleContext(currentDeployment(state.artifact?.events ?? []));
  const inputFields = fn.inputs.map((input, index) => {
    const example = executionArgumentExample(input, exampleContext);
    const value = state.functionValues[index] ?? example.value;
    const validation = validateArgument(input.type, value);
    return `<label class="argument-field"><span>${escapeHtml(input.name || `arg${index}`)} <code>${escapeHtml(input.type)}</code></span><input type="text" data-argument-index="${index}" value="${escapeHtml(value)}" placeholder="${escapeHtml(input.type.endsWith("]") || input.type.startsWith("(") ? "JSON value" : input.type)}" aria-describedby="argument-help-${index}" /><small id="argument-help-${index}" class="${validation.status}">${escapeHtml(validation.text)}</small><small class="example-source"><strong>Example source</strong>${escapeHtml(example.source)}</small></label>`;
  }).join("");
  const observedFrames = flattenTrace(tracePayload?.trace).filter(call => call.contractId === contract.id && call.selector === fn.selector);
  const opcodeSteps = state.executionResult?.opcodeProfile?.totalSteps ?? tracePayload?.opcodeProfile?.totalSteps;
  const isRead = ["view", "pure"].includes(fn.stateMutability);
  const simulationReady = state.executionResult?.kind === "simulation" && state.executionResult.status === "success";
  const writeAction = isRead ? "" : state.deploymentSource === "local"
    ? `<button type="button" id="execute-local" class="execution-primary"${busy ? " disabled" : ""}>Execute on local devnet</button>`
    : `<label class="execution-consent"><input type="checkbox" id="sepolia-execution-consent"${state.executionSepoliaConfirmed ? " checked" : ""} /><span><strong>Connected wallet approval</strong>I reviewed the exact target, calldata, value, and Sepolia gas responsibility.</span></label><button type="button" id="execute-sepolia" class="execution-primary"${busy || !simulationReady || !state.executionSepoliaConfirmed ? " disabled" : ""}>Send with connected wallet</button>`;
  const resultKind = state.executionResult?.kind;
  const evidenceTitle = state.executionResult
    ? ["transaction", "transaction-analysis"].includes(resultKind) ? "Mined transaction evidence" : "Simulation evidence"
    : observedFrames.length ? `${observedFrames.length} matching recorded frame${observedFrames.length === 1 ? "" : "s"}` : "Ready to simulate";
  const evidenceText = state.executionResult
    ? ["transaction", "transaction-analysis"].includes(resultKind) ? "Receipt-bound evidence may include state, logs, gas, calls, and opcodes depending on RPC capabilities." : "Simulation explains current behavior without claiming that state changed."
    : "Choose inputs and simulate first. Write functions can then use the isolated local actor or an explicitly connected Sepolia wallet.";
  const error = state.executionError ? `<div class="execution-error" role="alert"><strong>Execution could not be completed</strong><p>${escapeHtml(state.executionError)}</p></div>` : "";
  const routePreview = `<section class="execution-route-preview" aria-label="Selected call route"><div><span>1 · Caller</span><code>${escapeHtml(short(state.functionCaller || "RPC default", 10, 8))}</code></div><i aria-hidden="true">→</i><div><span>2 · Contract</span><strong>${escapeHtml(contract.name)}</strong><code>${escapeHtml(short(contract.address, 10, 8))}</code></div><i aria-hidden="true">→</i><div><span>3 · Selector</span><code>${escapeHtml(fn.selector)}</code><small>${escapeHtml(fn.stateMutability)}</small></div><i aria-hidden="true">→</i><div><span>4 · EVM outcome</span><strong>${state.executionResult ? escapeHtml(titleCase(state.executionResult.status)) : "Not simulated"}</strong><small>${escapeHtml(fn.outputs.length ? fn.outputs.map(item => item.type).join(", ") : "no ABI output")}</small></div><p><strong>Why this function exists.</strong> ${escapeHtml(fn.purpose ?? fn.behavior)}</p></section>`;
  root.className = "surface execution-workspace";
  root.innerHTML = `<div class="execution-workspace-heading"><div><p class="eyebrow">EXECUTION WORKSPACE</p><h2>Run, trace, and explain Loom execution</h2><p>Use deployment-wide evidence first, then inspect exact calldata and EVM behavior for ${escapeHtml(contract.name)}.</p></div><span class="execution-selection"><strong>${escapeHtml(contract.name)}</strong><code>${escapeHtml(fn.signature)}</code><small>${escapeHtml(networkName)}</small></span></div>${tools}${routePreview}<div class="execution-workspace-grid"><section class="argument-editor"><div class="section-title"><div><p class="eyebrow">HYPOTHETICAL INPUT</p><h3>Input values</h3><p>Deployment- and scenario-aware examples are filled in automatically. Review them before simulation or publication.</p></div><div><span>${escapeHtml(fn.stateMutability)}</span><button type="button" id="restore-example-inputs" class="subtle-action">Restore examples</button></div></div><div class="execution-input-grid"><label class="argument-field"><span>Caller <code>address</code></span><input type="text" id="function-caller" value="${escapeHtml(state.functionCaller)}" placeholder="Optional eth_call sender" /><small>${state.deploymentSource === "local" ? `Local writes use the fixed Anvil test actor ${short(LOCAL_TEST_SENDER, 8, 6)}.` : "Simulation caller only; the connected wallet controls the real transaction sender."}</small></label><label class="argument-field"><span>Call value <code>uint256 wei</code></span><input type="text" id="function-call-value" value="${escapeHtml(state.functionCallValue)}" inputmode="numeric" /><small>${fn.stateMutability === "payable" ? "Example value is zero; enter wei only when the function should receive native value." : "Non-payable functions require zero value."}</small></label>${inputFields || `<p class="empty">This function has no calldata arguments.</p>`}</div><div class="execution-actions"><button type="button" id="simulate-execution"${busy ? " disabled" : ""}>${state.executionStatus === "simulating" ? "Simulating..." : "Simulate without sending"}</button>${writeAction}</div>${error}</section><aside class="execution-evidence"><p class="eyebrow">EVIDENCE MODE</p><h3>${escapeHtml(evidenceTitle)}</h3><p>${escapeHtml(evidenceText)}</p><div class="execution-scope"><span>Input + output</span><span>Contract calls</span><span>State diff</span><span>EVM frames</span><span>${opcodeSteps ? `${escapeHtml(opcodeSteps)} recorded opcode steps` : "Opcodes"}</span></div></aside></div>${renderProbeResult(state.executionProbeResult)}${renderExecutionResult(state.executionResult)}`;
}

function executionRequestBody(contract, fn) {
  const exampleContext = executionExampleContext(currentDeployment(state.artifact?.events ?? []));
  return {
    network: state.deploymentSource,
    contractId: contract.id,
    selector: fn.selector,
    args: fn.inputs.map((input, index) => state.functionValues[index] ?? defaultExecutionArgument(input, exampleContext)),
    valueWei: state.functionCallValue || "0",
    ...(state.functionCaller ? { from: state.functionCaller } : {})
  };
}

async function requestExecution(path, body, status) {
  state.executionStatus = status;
  state.executionError = null;
  renderDeployment(state.artifact?.events ?? []);
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? "Execution request was rejected");
    state.executionResult = payload;
    state.executionStatus = payload.status;
    return payload;
  } catch (error) {
    state.executionStatus = "error";
    state.executionError = error?.message ?? "Execution request failed";
    return null;
  } finally {
    renderDeployment(state.artifact?.events ?? []);
  }
}

async function runExecutionSimulation() {
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const contract = selectedContract(deployment);
  const fn = selectedFunction(contract);
  if (!contract || !fn) return;
  await requestExecution("/api/execution/simulate", executionRequestBody(contract, fn), "simulating");
}

async function runLocalExecution() {
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const contract = selectedContract(deployment);
  const fn = selectedFunction(contract);
  if (!contract || !fn || state.deploymentSource !== "local") return;
  await requestExecution("/api/execution/local", executionRequestBody(contract, fn), "broadcasting");
}

async function runLocalProbe(scope) {
  if (state.deploymentSource !== "local") return;
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const contract = selectedContract(deployment);
  if (scope === "contract" && !contract) return;
  state.executionStatus = "probing";
  state.executionError = null;
  state.executionProbeResult = null;
  renderDeployment(state.artifact?.events ?? []);
  try {
    const response = await fetch("/api/execution/local/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: "local", ...(scope === "contract" ? { contractIds: [contract.id] } : {}) })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? "Local function probe was rejected");
    state.executionProbeResult = payload;
    state.executionStatus = "success";
  } catch (error) {
    state.executionStatus = "error";
    state.executionError = error?.message ?? "Local function probe failed";
  } finally {
    renderDeployment(state.artifact?.events ?? []);
  }
}

async function inspectSepoliaExecution() {
  if (state.deploymentSource !== "sepolia" || !state.executionTransactionHash) return;
  const result = await requestExecution("/api/execution/sepolia/analyze", { transactionHash: state.executionTransactionHash }, "confirming");
  if (!result) return;
  state.architectureTransactionOpen = true;
  state.traceOverlayEnabled = result.capabilities?.callTrace === "available";
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const journey = buildTransactionArchitectureJourney(deployment, result);
  const touched = new Set(journey.observedNodeIds);
  const groups = architectureView(deployment).groups.filter(group => group.members.some(node => touched.has(node.id))).map(group => group.id);
  state.expandedArchitectureGroups = [...new Set([...state.expandedArchitectureGroups, ...groups])];
  renderDeployment(state.artifact?.events ?? []);
  renderEvmTrace(result);
}

async function sendSepoliaExecution() {
  if (!state.executionResult?.transaction || state.deploymentSource !== "sepolia" || !state.executionSepoliaConfirmed) return;
  const provider = globalThis.ethereum;
  if (!provider?.request) {
    state.executionError = "No EIP-1193 wallet is connected to this browser. Copy the exact transaction request from the simulation, publish it with an independent wallet, then paste its transaction hash here.";
    renderDeployment(state.artifact?.events ?? []);
    return;
  }
  state.executionStatus = "broadcasting";
  state.executionError = null;
  renderDeployment(state.artifact?.events ?? []);
  try {
    let chainId = await provider.request({ method: "eth_chainId" });
    if (String(chainId).toLowerCase() !== "0xaa36a7") {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
      chainId = await provider.request({ method: "eth_chainId" });
    }
    if (String(chainId).toLowerCase() !== "0xaa36a7") throw new Error("Connected wallet did not switch to Ethereum Sepolia");
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("Connected wallet did not expose a sender account");
    const deployment = currentDeployment(state.artifact?.events ?? []);
    const contract = selectedContract(deployment);
    const fn = selectedFunction(contract);
    if (!contract || !fn) throw new Error("The selected deployment function is no longer available");
    const freshSimulation = await requestExecution(
      "/api/execution/simulate",
      { ...executionRequestBody(contract, fn), from: accounts[0] },
      "simulating"
    );
    if (!freshSimulation || freshSimulation.status !== "success") throw new Error("The exact call reverted for the connected Sepolia account; nothing was sent");
    const transaction = freshSimulation.transaction;
    const transactionHash = await provider.request({ method: "eth_sendTransaction", params: [{ from: accounts[0], to: transaction.to, data: transaction.data, value: transaction.value }] });
    state.functionCaller = accounts[0];
    state.executionTransactionHash = transactionHash;
    state.executionStatus = "confirming";
    await inspectSepoliaExecution();
  } catch (error) {
    state.executionStatus = "error";
    state.executionError = error?.message ?? "Connected wallet rejected the transaction";
    renderDeployment(state.artifact?.events ?? []);
  }
}

function traceBigInt(value) {
  try { return value === null || value === undefined ? 0n : BigInt(value); } catch { return 0n; }
}

function formatTraceNumber(value) {
  if (value === null || value === undefined) return EMPTY;
  const parsed = traceBigInt(value);
  return parsed.toLocaleString("en-US");
}

function flattenTraceFrames(node, path = "0", result = []) {
  if (!node) return result;
  result.push({ ...node, path, depth: path.split(".").length - 1 });
  (node.calls ?? []).forEach((child, index) => flattenTraceFrames(child, `${path}.${index}`, result));
  return result;
}

function traceLabel(frame) {
  return frame.functionSignature ?? (frame.selector && frame.selector !== "0x" ? frame.selector : "fallback / receive");
}

function renderTraceWaterfall(frames, rootGas) {
  if (!frames.length) return `<div class="empty">No call frames match these filters.</div>`;
  return `<div class="waterfall-head"><span>Call / function</span><span>Inclusive gas</span></div><ol class="call-waterfall">${frames.map(frame => {
    const gas = traceBigInt(frame.gasUsed);
    const width = rootGas > 0n ? Math.min(100, Math.max(2, Number((gas * 10000n) / rootGas) / 100)) : 2;
    return `<li style="--trace-indent:${Math.min(frame.depth, 6)}rem"><button type="button" class="waterfall-row${frame.path === state.selectedTracePath ? " selected" : ""}${frame.error ? " error" : ""}" data-trace-path="${escapeHtml(frame.path)}" data-trace-contract="${escapeHtml(frame.contractId ?? "")}" data-trace-selector="${escapeHtml(frame.selector ?? "")}" aria-pressed="${frame.path === state.selectedTracePath}"><span class="trace-type ${escapeHtml(String(frame.type ?? "call").toLowerCase())}">${escapeHtml(frame.type ?? "CALL")}</span><span class="waterfall-call"><strong>${escapeHtml(frame.contractName ?? short(frame.to, 9, 7))}</strong><code>${escapeHtml(traceLabel(frame))}</code></span><span class="gas-cell"><span>${escapeHtml(formatTraceNumber(frame.gasUsed))}</span><i style="width:${width}%"></i></span>${frame.error ? `<em>${escapeHtml(frame.revertReason ?? frame.error)}</em>` : ""}</button></li>`;
  }).join("")}</ol>`;
}

function renderTraceFrameInspector(frame) {
  if (!frame) return `<div class="empty">Select a call frame to inspect its execution context.</div>`;
  const status = frame.error ? "error" : "success";
  const inputBytes = typeof frame.input === "string" ? Math.max(0, (frame.input.length - 2) / 2) : 0;
  const outputBytes = typeof frame.output === "string" ? `${Math.max(0, (frame.output.length - 2) / 2)} B` : EMPTY;
  return `<div class="frame-heading"><div><p class="eyebrow">FRAME ${escapeHtml(frame.path)}</p><h3>${escapeHtml(frame.contractName ?? short(frame.to, 10, 8))}</h3><code>${escapeHtml(traceLabel(frame))}</code></div><span class="status ${status}">${frame.error ? "Reverted" : "Returned"}</span></div><div class="frame-metrics">${field("Call type", frame.type ?? "CALL", { code: true })}${field("Depth", frame.depth, { code: true })}${field("Gas supplied", formatTraceNumber(frame.gas), { code: true })}${field("Gas used", formatTraceNumber(frame.gasUsed), { code: true })}${field("Value (wei)", formatTraceNumber(frame.value), { code: true })}${field("Input / output", `${inputBytes} B / ${outputBytes}`, { code: true })}</div>${frame.error ? `<div class="trace-revert"><strong>Revert</strong><code>${escapeHtml(frame.revertReason ?? frame.error)}</code></div>` : ""}<div class="address-route"><div><span>From</span><code>${escapeHtml(frame.from ?? EMPTY)}</code></div><i aria-hidden="true">→</i><div><span>To</span><code>${escapeHtml(frame.to ?? EMPTY)}</code></div></div><details><summary>Calldata and return data</summary><div class="payload-pair"><div><h3>Input</h3>${jsonBlock(frame.input ?? "0x", "Frame calldata")}</div><div><h3>Output</h3>${jsonBlock(frame.output ?? "0x", "Frame return data")}</div></div></details>`;
}

function opcodeGroup(opcode) {
  if (["CALL", "CALLCODE", "STATICCALL", "DELEGATECALL", "CREATE", "CREATE2"].includes(opcode)) return "call";
  if (["SLOAD", "TLOAD", "MLOAD", "CALLDATALOAD"].includes(opcode)) return "read";
  if (["SSTORE", "TSTORE", "MSTORE", "MSTORE8"].includes(opcode)) return "write";
  if (["JUMP", "JUMPI", "JUMPDEST"].includes(opcode)) return "control";
  if (["KECCAK256", "SHA3"].includes(opcode)) return "crypto";
  if (["RETURN", "REVERT", "STOP", "SELFDESTRUCT"].includes(opcode)) return "exit";
  return "other";
}

function opcodePhase(opcode) {
  if (["CALL", "CALLCODE", "STATICCALL", "DELEGATECALL", "CREATE", "CREATE2"].includes(opcode)) return "external-call";
  if (["SLOAD", "TLOAD", "SSTORE", "TSTORE"].includes(opcode)) return "state";
  if (["MLOAD", "MSTORE", "MSTORE8", "MSIZE", "CALLDATALOAD", "CALLDATACOPY", "CALLDATASIZE", "CODECOPY", "RETURNDATACOPY"].includes(opcode)) return "data-memory";
  if (["JUMP", "JUMPI", "JUMPDEST"].includes(opcode)) return "control";
  if (["KECCAK256", "SHA3", "ECRECOVER"].includes(opcode)) return "crypto";
  if (opcode.startsWith("LOG")) return "event";
  if (["RETURN", "REVERT", "STOP", "SELFDESTRUCT", "INVALID"].includes(opcode)) return "exit";
  return "compute";
}

function renderOpcodePhaseFlow(profile) {
  const steps = profile?.steps ?? profile?.importantSteps ?? [];
  if (!steps.length) return `<p class="empty">No ordered opcode sequence is available for phase visualization.</p>`;
  const phases = [];
  for (const step of steps) {
    const name = opcodePhase(step.op);
    const previous = phases.at(-1);
    if (previous?.name === name && previous.depth === step.depth) {
      previous.steps += 1;
      previous.gas += Number(step.gasCost ?? 0);
      previous.end = Number(step.index) + 1;
    } else {
      phases.push({ name, depth: step.depth, steps: 1, gas: Number(step.gasCost ?? 0), start: Number(step.index) + 1, end: Number(step.index) + 1 });
    }
  }
  const visible = phases.slice(0, 80);
  const maxSteps = Math.max(...visible.map(phase => phase.steps), 1);
  return `<section class="opcode-phase-flow"><div class="section-title"><div><p class="eyebrow">EVM PHASE FLOW</p><h3>How execution moved through the VM</h3><p>Consecutive instructions are grouped by behavior while preserving order and call depth.</p></div><span>${escapeHtml(phases.length)} phases</span></div><div class="phase-lane" aria-label="Ordered EVM execution phases">${visible.map((phase, index) => `<article class="${escapeHtml(phase.name)}" style="--phase-weight:${Math.max(1, Math.round((phase.steps / maxSteps) * 8))}" title="Steps ${phase.start}-${phase.end}; depth ${phase.depth}; ${phase.gas} gas"><span>${index + 1}</span><strong>${escapeHtml(titleCase(phase.name))}</strong><small>${escapeHtml(phase.steps)} op · depth ${escapeHtml(phase.depth)}</small></article>`).join("")}</div>${phases.length > visible.length ? `<p class="evidence-note">Showing the first ${visible.length} of ${phases.length} ordered phases. The complete instruction lane remains below.</p>` : ""}</section>`;
}

function renderOpcodeExplorer(profile) {
  if (!profile) return `<div class="empty">Opcode-level evidence was not captured.</div>`;
  const counts = Object.entries(profile.opcodeCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, ...counts.map(([, count]) => count));
  const importantSteps = profile.importantSteps ?? [];
  const allSteps = profile.steps ?? importantSteps;
  const selectedSteps = state.opcodeView === "all" ? allSteps : importantSteps;
  const maxGasCost = selectedSteps.reduce((maximum, step) => Math.max(maximum, Number(step.gasCost ?? 0)), 1);
  const viewDescription = state.opcodeView === "all" ? "Every captured instruction in exact execution order." : "State access, calls, creation, hashing, logs, and frame exits in exact execution order.";
  return `<section class="opcode-explorer"><div class="section-title"><div><p class="eyebrow">OPCODE EXPLORER</p><h2>Instruction-level EVM movement</h2><p>Frequency explains what dominated the run; the ordered lane keeps instructions attached to their original program counter, depth, and gas cost.</p></div><span>${escapeHtml(profile.totalSteps)} total steps${profile.stepsTruncated ? ` / first ${escapeHtml(allSteps.length)} captured` : ""}</span></div>${renderOpcodePhaseFlow(profile)}<div class="opcode-view-filter" role="group" aria-label="Opcode detail"><button type="button" data-opcode-view="important" aria-pressed="${state.opcodeView === "important"}">State and calls · ${escapeHtml(importantSteps.length)}</button><button type="button" data-opcode-view="all" aria-pressed="${state.opcodeView === "all"}">All captured steps · ${escapeHtml(allSteps.length)}</button></div><div class="opcode-layout"><div><h3>Opcode frequency</h3><div class="opcode-frequency">${counts.map(([opcode, count]) => `<div title="${escapeHtml(opcodePurpose(opcode))}"><code>${escapeHtml(opcode)}</code><span><i class="${opcodeGroup(opcode)}" style="width:${Math.max(2, (count / maxCount) * 100)}%"></i></span><strong>${escapeHtml(count)}</strong></div>`).join("")}</div></div><div><h3>EVM program counter</h3><p class="opcode-column-help">${escapeHtml(viewDescription)} PC is the byte offset in deployed bytecode; depth identifies the active call frame.</p><div class="opcode-lanes" aria-label="EVM PROGRAM COUNTER">${selectedSteps.map(step => `<article class="opcode-step ${opcodeGroup(step.op)}" style="--opcode-indent:${Math.min(Number(step.depth ?? 0), 6) * .6}rem"><span>${escapeHtml(Number(step.index) + 1)}</span><strong>${escapeHtml(step.op)}</strong><code>pc ${escapeHtml(step.pc)}</code><code>depth ${escapeHtml(step.depth)}</code><div title="${escapeHtml(step.gasCost)} gas"><i style="width:${Math.max(2, (Number(step.gasCost ?? 0) / maxGasCost) * 100)}%"></i></div><small>${escapeHtml(step.gasCost)} gas</small><p>${escapeHtml(opcodePurpose(step.op))}</p></article>`).join("")}</div></div></div><div class="opcode-legend"><span class="call">Call</span><span class="read">Read</span><span class="write">Write</span><span class="control">Control</span><span class="crypto">Crypto</span><span class="exit">Exit</span></div><p class="evidence-note">Stack, memory, and raw storage payloads are intentionally excluded to keep evidence bounded and prevent accidental disclosure. Program counters, depth, gas cost, opcode order, call frames, and the separately bounded state diff remain available.</p></section>`;
}

function renderEvmBehaviorSummary(tracePayload) {
  const root = $("#evm-behavior-summary");
  if (!tracePayload?.trace) {
    root.className = "evm-behavior-summary empty";
    root.textContent = "Local trace evidence is required for an EVM behavior profile.";
    return;
  }
  const frames = flattenTraceFrames(tracePayload.trace);
  const counts = tracePayload.opcodeProfile?.opcodeCounts ?? {};
  const count = names => names.reduce((total, name) => total + Number(counts[name] ?? 0), 0);
  const metrics = [
    { label: "State access", value: count(["SLOAD", "SSTORE", "TLOAD", "TSTORE"]), detail: `${count(["SLOAD", "TLOAD"])} reads · ${count(["SSTORE", "TSTORE"])} writes`, tone: "state" },
    { label: "External calls", value: count(["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"]), detail: `${Math.max(0, frames.length - 1)} decoded child frames`, tone: "call" },
    { label: "Event logs", value: count(["LOG0", "LOG1", "LOG2", "LOG3", "LOG4"]), detail: "LOG opcodes in this execution", tone: "event" },
    { label: "Hashing", value: count(["KECCAK256", "SHA3"]), detail: "memory commitments and mapping keys", tone: "crypto" },
    { label: "Control flow", value: count(["JUMP", "JUMPI", "JUMPDEST"]), detail: "branches and destinations", tone: "control" },
    { label: "Exit / revert", value: count(["RETURN", "REVERT", "STOP", "INVALID", "SELFDESTRUCT"]), detail: `${frames.filter(frame => frame.error).length} reverted frames`, tone: "exit" }
  ];
  const maximum = Math.max(1, ...metrics.map(metric => metric.value));
  const hotFrames = [...frames].sort((left, right) => Number(traceBigInt(right.gasUsed) - traceBigInt(left.gasUsed))).slice(0, 4);
  root.className = "evm-behavior-summary";
  root.innerHTML = `<div class="evm-behavior-heading"><div><p class="eyebrow">TRANSACTION BEHAVIOR MAP</p><h2>What this execution made the EVM do</h2><p>This profile is descriptive evidence for one transaction, not a gas promise for every input or account configuration.</p></div><button type="button" data-open-execution-studio>Model another function</button></div><div class="evm-behavior-grid">${metrics.map(metric => `<article class="${escapeHtml(metric.tone)}"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong><p>${escapeHtml(metric.detail)}</p><i><b style="width:${Math.max(2, metric.value / maximum * 100)}%"></b></i></article>`).join("")}</div><div class="evm-route-map"><div><span>1</span><strong>Calldata</strong><small>selector + ABI arguments</small></div><i>→</i><div><span>2</span><strong>Authority</strong><small>EntryPoint + validator checks</small></div><i>→</i><div><span>3</span><strong>Account execution</strong><small>hooks + policy + calls</small></div><i>→</i><div><span>4</span><strong>State and logs</strong><small>observable chain effects</small></div><i>→</i><div><span>5</span><strong>Receipt</strong><small>gas + status + provenance</small></div></div><section class="evm-hot-frames"><div class="section-title"><div><p class="eyebrow">GAS HOTSPOTS</p><h3>Most expensive inclusive call frames</h3></div><span>Child gas overlaps parent gas</span></div>${hotFrames.map((frame, index) => `<button type="button" data-trace-path="${escapeHtml(frame.path)}" data-trace-contract="${escapeHtml(frame.contractId ?? "")}" data-trace-selector="${escapeHtml(frame.selector ?? "")}"><span>${index + 1}</span><div><strong>${escapeHtml(frame.contractName ?? short(frame.to, 10, 8))}</strong><code>${escapeHtml(traceLabel(frame))}</code></div><em>${escapeHtml(formatTraceNumber(frame.gasUsed))} gas</em></button>`).join("")}</section>`;
}

function renderEvmTrace(tracePayload) {
  const root = $("#evm-trace");
  const summary = tracePayload?.summary;
  renderEvmBehaviorSummary(tracePayload);
  if (!tracePayload?.trace) {
    root.className = "evm-trace empty";
    root.textContent = "Run the deterministic scenario to capture a transaction trace.";
    $("#evm-trace-summary").textContent = "No trace captured";
    return;
  }
  root.className = "evm-trace";
  const allFrames = flattenTraceFrames(tracePayload.trace);
  if (!allFrames.some(frame => frame.path === state.selectedTracePath)) state.selectedTracePath = allFrames[0]?.path ?? "0";
  const selectedFrame = allFrames.find(frame => frame.path === state.selectedTracePath) ?? allFrames[0];
  const query = state.traceSearch.toLowerCase();
  const frames = allFrames.filter(frame => (state.traceType === "all" || frame.type === state.traceType) && (!query || [frame.contractName, frame.functionSignature, frame.selector, frame.from, frame.to].join(" ").toLowerCase().includes(query)));
  const rootGas = traceBigInt(allFrames[0]?.gasUsed);
  const totalChildGas = allFrames.slice(1).reduce((total, frame) => total + traceBigInt(frame.gasUsed), 0n);
  const callTypes = [...new Set(allFrames.map(frame => frame.type).filter(Boolean))];
  $("#evm-trace-summary").textContent = `${summary.calls} frames / depth ${summary.maxDepth} / ${summary.errors} errors`;
  const profile = tracePayload.opcodeProfile;
  root.innerHTML = `<div class="trace-provenance">${field("Transaction", tracePayload.transactionHash, { code: true, short: true })}${field("Tracer", tracePayload.method, { code: true })}${field("Root gas used", formatTraceNumber(allFrames[0]?.gasUsed), { code: true })}${field("Call frames", summary.calls, { code: true })}${field("Maximum depth", summary.maxDepth, { code: true })}${field("Reverted frames", summary.errors, { code: true })}</div><div class="trace-toolbar"><label><span>Find a call</span><input id="trace-search" type="search" value="${escapeHtml(state.traceSearch)}" placeholder="Contract, function, address..." /></label><label><span>Call type</span><select id="trace-type"><option value="all">All call types</option>${callTypes.map(type => `<option value="${escapeHtml(type)}"${type === state.traceType ? " selected" : ""}>${escapeHtml(type)}</option>`).join("")}</select></label></div><section class="gas-distribution"><div class="section-title"><div><p class="eyebrow">INCLUSIVE COST</p><h2>Gas distribution</h2></div><span>Child frames overlap their parents</span></div><div class="gas-summary"><div><strong>${escapeHtml(formatTraceNumber(rootGas))}</strong><span>root frame gas</span></div><div><strong>${escapeHtml(formatTraceNumber(totalChildGas))}</strong><span>child frame total</span></div><div><strong>${escapeHtml(profile?.totalSteps ?? EMPTY)}</strong><span>opcode steps</span></div></div></section><div class="trace-debugger"><section class="trace-waterfall"><div class="section-title"><div><p class="eyebrow">CALL STACK</p><h2>Call waterfall</h2></div><span>${frames.length} of ${allFrames.length} frames</span></div>${renderTraceWaterfall(frames, rootGas)}</section><aside id="trace-frame-inspector" class="trace-frame-inspector">${renderTraceFrameInspector(selectedFrame)}</aside></div>${renderOpcodeExplorer(profile)}`;
}

function recoveryEvidenceStatus(deployment, contractLabel) {
  const aliases = {
    "Guardian verifiers": ["ECDSAGuardianVerifier", "P256GuardianVerifier", "ERC1271GuardianVerifier"],
    "ECDSA / P256 / ERC1271 verifier": ["ECDSAGuardianVerifier", "P256GuardianVerifier", "ERC1271GuardianVerifier"]
  };
  const names = aliases[contractLabel] ?? contractLabel.split(" → ");
  const matched = names.map(name => deployment?.nodes?.find(node => node.name === name || node.id === name)).filter(Boolean);
  if (!matched.length) return ["Source-defined", "source"];
  if (matched.every(node => node.address)) return ["Deployed in this run", "deployed"];
  return ["Source-defined only", "source"];
}

const RECOVERY_NODE_WIDTH = 220;
const RECOVERY_NODE_HEIGHT = 126;

function recoveryEdgeGeometry(edge, nodesById, graphHeight) {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  if (!from || !to) return null;
  if (to.x < from.x) {
    const laneY = graphHeight - 34;
    return {
      path: `M ${from.x + RECOVERY_NODE_WIDTH / 2} ${from.y + RECOVERY_NODE_HEIGHT} C ${from.x + RECOVERY_NODE_WIDTH / 2} ${laneY}, ${to.x + RECOVERY_NODE_WIDTH / 2} ${laneY}, ${to.x + RECOVERY_NODE_WIDTH / 2} ${to.y + RECOVERY_NODE_HEIGHT}`,
      labelX: (from.x + to.x + RECOVERY_NODE_WIDTH) / 2,
      labelY: laneY - 10,
      returning: true
    };
  }
  const startsBelow = to.y > from.y + 40;
  const startX = startsBelow ? from.x + RECOVERY_NODE_WIDTH / 2 : from.x + RECOVERY_NODE_WIDTH;
  const startY = startsBelow ? from.y + RECOVERY_NODE_HEIGHT : from.y + RECOVERY_NODE_HEIGHT / 2;
  const endX = startsBelow ? to.x + RECOVERY_NODE_WIDTH / 2 : to.x;
  const endY = startsBelow ? to.y : to.y + RECOVERY_NODE_HEIGHT / 2;
  const bend = startsBelow ? Math.max(34, (endY - startY) / 2) : Math.max(30, (endX - startX) / 2);
  return {
    path: startsBelow
      ? `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`
      : `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: startsBelow ? (startY + endY) / 2 - 11 : Math.min(from.y, to.y) - 16,
    returning: false
  };
}

function recoveryNodeTitle(title) {
  const words = title.split(" ");
  const lines = [""];
  for (const word of words) {
    const line = lines.at(-1);
    if (line && `${line} ${word}`.length > 30 && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines;
}

function renderRecoveryLifecycle() {
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const lifecycle = buildRecoveryLifecycle(state.recoveryMode, state.selectedRecoveryStepId);
  state.recoveryMode = lifecycle.mode;
  state.selectedRecoveryStepId = lifecycle.selected.id;
  $$('[data-recovery-mode]').forEach(button => button.setAttribute("aria-pressed", String(button.dataset.recoveryMode === lifecycle.mode)));
  const nodesById = new Map(lifecycle.nodes.map(node => [node.id, node]));
  const selectedConnections = new Set(lifecycle.edges.flatMap(edge => edge.from === lifecycle.selected.id || edge.to === lifecycle.selected.id ? [edge.from, edge.to] : []));
  const markerId = `recovery-arrow-${lifecycle.mode}`;
  const edges = lifecycle.edges.map(edge => {
    const geometry = recoveryEdgeGeometry(edge, nodesById, lifecycle.layout.height);
    if (!geometry) return "";
    const active = edge.from === lifecycle.selected.id || edge.to === lifecycle.selected.id;
    return `<g class="recovery-graph-edge ${active ? "active" : ""} ${geometry.returning ? "returning" : ""}"><path d="${geometry.path}" marker-end="url(#${markerId})"/><text x="${geometry.labelX}" y="${geometry.labelY}" text-anchor="middle">${escapeHtml(edge.label)}</text></g>`;
  }).join("");
  const nodes = lifecycle.nodes.map((node, index) => {
    const [evidence, evidenceClass] = recoveryEvidenceStatus(deployment, node.contract);
    const selected = node.id === lifecycle.selected.id;
    const related = selected || selectedConnections.has(node.id);
    const title = recoveryNodeTitle(node.title).map(line => `<span>${escapeHtml(line)}</span>`).join("");
    const boundary = `${titleCase(node.layer)} · ${node.actor}`;
    const payload = node.payload?.length ? `${node.payload.length} payload fields · ` : "";
    return `<foreignObject x="${node.x}" y="${node.y}" width="${RECOVERY_NODE_WIDTH}" height="${RECOVERY_NODE_HEIGHT}"><button xmlns="http://www.w3.org/1999/xhtml" type="button" class="recovery-graph-node layer-${escapeHtml(node.layer)} ${selected ? "selected" : ""} ${related ? "related" : "dimmed"}" data-recovery-step="${escapeHtml(node.id)}" aria-pressed="${selected}"><span class="recovery-node-index">${index + 1}</span><span class="recovery-node-copy"><small>${escapeHtml(boundary)}</small><strong>${title}</strong><code>${escapeHtml(payload + node.contract)} · ${escapeHtml(node.function)}</code></span><em class="${evidenceClass}">${escapeHtml(evidence)}</em></button></foreignObject>`;
  }).join("");
  const graphWidth = Math.round(lifecycle.layout.width * state.recoveryZoom);
  const graphHeight = Math.round(lifecycle.layout.height * state.recoveryZoom);
  $("#recovery-flow").innerHTML = `<header><div><p class="eyebrow">${escapeHtml(lifecycle.label)}</p><h2>${escapeHtml(lifecycle.description)}</h2></div><span>${lifecycle.nodes.length} contract-level stages · ${Math.round(state.recoveryZoom * 100)}% · wheel to zoom</span></header><div class="recovery-graph-viewport" aria-label="${escapeHtml(lifecycle.label)} contract flow"><svg class="recovery-graph" viewBox="0 0 ${lifecycle.layout.width} ${lifecycle.layout.height}" width="${graphWidth}" height="${graphHeight}" role="img" aria-labelledby="recovery-graph-title recovery-graph-description"><title id="recovery-graph-title">${escapeHtml(lifecycle.label)} contract flow</title><desc id="recovery-graph-description">A left-to-right map of ${lifecycle.nodes.length} authority-bearing stages. Select a node for its contract boundary and invariant.</desc><defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--green)"/></marker></defs>${edges}${nodes}</svg></div>`;
  const viewport = $("#recovery-flow .recovery-graph-viewport");
  viewport.scrollLeft = state.recoveryScrollLeft;
  viewport.scrollTop = state.recoveryScrollTop;
  viewport.addEventListener("scroll", () => {
    state.recoveryScrollLeft = viewport.scrollLeft;
    state.recoveryScrollTop = viewport.scrollTop;
  }, { passive: true });
  viewport.addEventListener("wheel", zoomRecoveryWithWheel, { passive: false });
  const selected = lifecycle.selected;
  const [evidence, evidenceClass] = recoveryEvidenceStatus(deployment, selected.contract);
  const incoming = lifecycle.edges.filter(edge => edge.to === selected.id);
  const outgoing = lifecycle.edges.filter(edge => edge.from === selected.id);
  const payloadDetail = selected.payload?.length ? `<div class="recovery-payload-row"><dt>Payload crossing the boundary</dt><dd>${selected.payload.map(value => `<code>${escapeHtml(value)}</code>`).join(" ")}</dd></div>` : "";
  $("#recovery-step-detail").innerHTML = `<header><p class="eyebrow">SELECTED TRANSITION</p><span class="recovery-evidence ${evidenceClass}">${escapeHtml(evidence)}</span><h2>${escapeHtml(selected.title)}</h2><p>${escapeHtml(selected.summary)}</p></header><dl><div><dt>Layer</dt><dd>${escapeHtml(titleCase(selected.layer))}</dd></div><div><dt>Actor</dt><dd>${escapeHtml(selected.actor)}</dd></div><div><dt>Contract boundary</dt><dd><code>${escapeHtml(selected.contract)}</code></dd></div><div><dt>Function / constant</dt><dd><code>${escapeHtml(selected.function)}</code></dd></div>${payloadDetail}<div><dt>On-chain effect</dt><dd>${escapeHtml(selected.state)}</dd></div></dl><section><strong>Safety invariant</strong><p>${escapeHtml(selected.invariant)}</p></section><section class="recovery-connections"><strong>Flow connections</strong>${[...incoming.map(edge => `Receives ${edge.label} from ${lifecycle.nodes.find(node => node.id === edge.from)?.title}.`), ...outgoing.map(edge => `Sends ${edge.label} to ${lifecycle.nodes.find(node => node.id === edge.to)?.title}.`)].map(value => `<p>${escapeHtml(value)}</p>`).join("") || `<p>This is the terminal state for this branch.</p>`}</section>`;
}

function zoomRecoveryWithWheel(event) {
  if (event.deltaY === 0) return;
  const viewport = event.currentTarget;
  const previousZoom = state.recoveryZoom;
  const next = zoomScrollAtPoint(
    { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, zoom: previousZoom },
    previousZoom * (event.deltaY < 0 ? 1.1 : .9),
    { x: event.clientX - viewport.getBoundingClientRect().left, y: event.clientY - viewport.getBoundingClientRect().top }
  );
  if (next.zoom === previousZoom) return;
  event.preventDefault();
  state.recoveryZoom = next.zoom;
  state.recoveryScrollLeft = next.scrollLeft;
  state.recoveryScrollTop = next.scrollTop;
  renderRecoveryLifecycle();
}

function renderDeployment(events = []) {
  const deployment = currentDeployment(events);
  const tracePayload = currentTrace(events);
  if (deployment?.nodes?.length && !deployment.nodes.some(node => node.id === state.selectedContractId)) {
    state.selectedContractId = deployment.nodes.find(node => node.kind === "account")?.id ?? deployment.nodes[0].id;
    state.selectedFunctionSelector = null;
  }
  const contract = selectedContract(deployment);
  if (contract && !contract.functions.some(fn => fn.selector === state.selectedFunctionSelector)) {
    state.selectedFunctionSelector = contract.functions[0]?.selector ?? null;
    state.functionValues = {};
  }
  const fn = selectedFunction(contract);
  renderDeploymentGraph(deployment);
  renderExecutionCatalog(deployment, contract, fn);
  renderExecutionWorkspace(contract, fn, tracePayload);
  renderSharedOperationLens(events);
  $("#contract-count").textContent = deployment?.nodes?.length ?? 0;
  renderDeploymentVerification();
  renderRecoveryLifecycle();
}

function switchTab(tab, focus = false) {
  state.activeTab = tab;
  if (tab !== "architecture") state.architectureImmersive = false;
  document.body.classList.toggle("architecture-immersive", tab === "architecture" && state.architectureImmersive);
  $$('[role="tab"]').forEach(button => {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  $$(".workspace-panel").forEach(panel => { panel.hidden = panel.id !== `panel-${tab}`; });
}

function render(artifact) {
  const openDetails = captureOpenDetails();
  state.artifact = artifact;
  $("#run-summary").textContent = `${artifact.scenario?.title ?? artifact.scenarioId} / ${artifact.runId}`;
  const status = $("#run-status");
  status.textContent = artifact.status;
  status.className = `status ${statusClass(artifact.status)}`;
  $("#metric-result").textContent = runOutcomeLabel(artifact.status);
  $("#metric-result-context").textContent = artifact.scenario?.title ?? artifact.scenarioId ?? "Unnamed Wallet Lab scenario";
  const chainId = artifact.environment?.chainId;
  $("#metric-network").textContent = networkLabel(chainId);
  $("#metric-chain").textContent = Number(chainId) === 31337 ? "Chain ID 31337 / deterministic local state" : Number(chainId) === 11155111 ? "Chain ID 11155111 / public test network" : chainId === undefined || chainId === null ? "Chain identity is unavailable." : `Chain ID ${chainId}`;
  const passingChecks = (artifact.invariants ?? []).filter(value => statusClass(value.status) === "success").length;
  const totalChecks = (artifact.invariants ?? []).length;
  $("#metric-checks").textContent = totalChecks ? `${passingChecks} of ${totalChecks} checks passed` : "No checks yet";
  $("#metric-checks-context").textContent = "Operation ID, receipt provenance, finality, and expected state changes.";
  $("#metric-duration").textContent = duration(artifact);
  $("#metric-duration-context").textContent = artifact.finishedAt ? "From environment startup through final evidence." : "The scenario is still collecting evidence.";
  $("#network-count").textContent = networkExchanges(artifact.events).length;
  $("#contract-count").textContent = currentDeployment(artifact.events)?.nodes?.length ?? 0;
  renderNetwork(artifact.events);
  renderDeployment(artifact.events);
  renderEvmTrace(currentTrace(artifact.events));
  if (state.deploymentSource === "sepolia" && currentTrace(artifact.events)?.kind !== "transaction-analysis") {
    $("#evm-trace").className = "evm-trace empty";
    $("#evm-trace").textContent = "Sepolia deployment inspection is read-only. Choose the local deterministic run to inspect its captured EVM transaction trace.";
    $("#evm-trace-summary").textContent = "No Sepolia transaction selected";
  }
  if (artifact.firstFailingBoundary) {
    $("#failure-panel").hidden = false;
    $("#failure").textContent = `${artifact.firstFailingBoundary}: inspect the matching Run step or Network request.`;
  } else {
    $("#failure-panel").hidden = true;
  }
  restoreOpenDetails(openDetails);
  switchTab(state.activeTab);
}

$(".workspace-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-tab]");
  if (button) {
    if (button.dataset.tab === "architecture") state.architectureImmersive = true;
    switchTab(button.dataset.tab, true);
  }
});

$(".workspace-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = $$('[role="tab"]');
  const current = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  switchTab(tabs[next].dataset.tab, true);
});

$("#panel-recovery").addEventListener("click", event => {
  const mode = event.target.closest("[data-recovery-mode]");
  if (mode) {
    state.recoveryMode = mode.dataset.recoveryMode;
    state.selectedRecoveryStepId = state.recoveryMode === "freeze" ? "freeze-digest" : "provision";
    state.recoveryZoom = 1;
    state.recoveryScrollLeft = 0;
    state.recoveryScrollTop = 0;
    renderRecoveryLifecycle();
    return;
  }
  const step = event.target.closest("[data-recovery-step]");
  if (!step) return;
  state.selectedRecoveryStepId = step.dataset.recoveryStep;
  renderRecoveryLifecycle();
});

$("#network-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-network-index]");
  if (!button || !state.artifact) return;
  state.selectedNetworkIndex = Number(button.dataset.networkIndex);
  renderNetwork(state.artifact.events);
});

$("#network-operation-groups").addEventListener("click", event => {
  const button = event.target.closest("[data-network-operation]");
  if (!button || !state.artifact) return;
  state.selectedNetworkOperation = button.dataset.networkOperation;
  state.selectedNetworkIndex = 0;
  renderNetwork(state.artifact.events);
});

$("#panel-architecture").addEventListener("click", event => {
  if (event.target.closest("#architecture-transaction-toggle")) {
    state.architectureTransactionOpen = !state.architectureTransactionOpen;
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    return;
  }
  if (event.target.closest("[data-transaction-close]")) {
    state.architectureTransactionOpen = false;
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    return;
  }
  if (event.target.closest("#architecture-analyze-transaction")) {
    inspectSepoliaExecution();
    return;
  }
  if (event.target.closest("[data-open-evm-evidence]")) {
    renderEvmTrace(currentTrace(state.artifact?.events ?? []));
    switchTab("evm", true);
    return;
  }
  const transactionContract = event.target.closest("[data-transaction-contract]");
  if (transactionContract) {
    focusArchitectureNode(transactionContract.dataset.transactionContract);
    return;
  }
  if (state.ignoreGraphClick && event.target.closest("#deployment-graph")) {
    state.ignoreGraphClick = false;
    return;
  }
  const close = event.target.closest("[data-focus-close]");
  if (close) {
    Object.assign(state, reduceArchitectureFocus(state, { type: "clear" }));
    state.focusedEdgeId = null;
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    return;
  }
  const back = event.target.closest("[data-focus-back]");
  if (back) {
    state.focusedAbiItem = null;
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    return;
  }
  const section = event.target.closest("[data-focus-section]");
  if (section) {
    const next = state.focusedSection === section.dataset.focusSection ? null : section.dataset.focusSection;
    Object.assign(state, reduceArchitectureFocus(state, { type: "focus-section", section: next }));
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    return;
  }
  const fn = event.target.closest("[data-focus-function]");
  if (fn) {
    Object.assign(state, reduceArchitectureFocus(state, { type: "focus-abi", section: "functions", itemId: fn.dataset.focusFunction }));
    const deployment = currentDeployment(state.artifact?.events ?? []);
    const lens = selectedFunctionLens(deployment);
    const relevantIds = new Set(lens?.observedNodeIds ?? []);
    const relevantGroups = architectureView(deployment).groups.filter(group => group.members.some(node => relevantIds.has(node.id))).map(group => group.id);
    state.expandedArchitectureGroups = [...new Set([...state.expandedArchitectureGroups, ...relevantGroups])];
    renderDeploymentGraph(deployment);
    return;
  }
  const edgeButton = event.target.closest("[data-edge-id], [data-focus-edge]");
  if (edgeButton) {
    const edgeId = edgeButton.dataset.edgeId ?? edgeButton.dataset.focusEdge;
    const deployment = currentDeployment(state.artifact?.events ?? []);
    const edge = deployment?.edges.find(candidate => architectureEdgeId(candidate) === edgeId);
    if (edge) {
      if (!state.focusedNodeId || ![edge.from, edge.to].includes(state.focusedNodeId)) focusArchitectureNode(edge.from);
      state.focusedSection = "relationships";
      state.focusedAbiItem = null;
      state.focusedEdgeId = edgeId;
      renderDeploymentGraph(deployment);
    }
    return;
  }
  const group = event.target.closest("[data-architecture-group]");
  if (group) {
    state.expandedArchitectureGroups = [...new Set([...state.expandedArchitectureGroups, group.dataset.architectureGroup])];
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    $("#architecture-live").textContent = `${group.getAttribute("aria-label")} expanded.`;
    return;
  }
  const collapseGroup = event.target.closest("[data-collapse-group]");
  if (collapseGroup) {
    state.expandedArchitectureGroups = state.expandedArchitectureGroups.filter(id => id !== collapseGroup.dataset.collapseGroup);
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    return;
  }
  const contractButton = event.target.closest("[data-contract-id]");
  if (contractButton) {
    focusArchitectureNode(contractButton.dataset.contractId);
    return;
  }
});

$("#panel-architecture").addEventListener("input", event => {
  if (event.target.id !== "architecture-transaction-hash") return;
  state.executionTransactionHash = event.target.value.trim();
  const analyze = $("#architecture-analyze-transaction");
  if (analyze) analyze.disabled = !state.executionTransactionHash || state.executionStatus === "confirming";
});

function selectAuthorityActor(authorityId) {
  state.selectedAuthorityId = authorityId;
  const deployment = currentDeployment(state.artifact?.events ?? []);
  if (deployment?.nodes?.some(node => node.id === authorityId)) state.selectedContractId = authorityId;
  renderDeployment(state.artifact?.events ?? []);
}

$("#panel-authority").addEventListener("click", event => {
  const actor = event.target.closest("[data-authority-id]");
  if (actor) selectAuthorityActor(actor.dataset.authorityId);
});

$("#panel-authority").addEventListener("keydown", event => {
  if (!["Enter", " "].includes(event.key)) return;
  const actor = event.target.closest("[data-authority-id]");
  if (!actor) return;
  event.preventDefault();
  selectAuthorityActor(actor.dataset.authorityId);
});

$("#panel-privacy").addEventListener("click", event => {
  const disclosure = event.target.closest("[data-disclosure-id]");
  if (!disclosure) return;
  state.selectedDisclosureId = disclosure.dataset.disclosureId;
  renderPrivacyView(currentOperationLens());
});

$("#deployment-graph").addEventListener("pointerdown", beginGraphInteraction);
$("#deployment-graph").addEventListener("pointermove", moveGraphInteraction);
$("#deployment-graph").addEventListener("pointerup", endGraphInteraction);
$("#deployment-graph").addEventListener("pointercancel", endGraphInteraction);
$("#deployment-graph").addEventListener("wheel", zoomArchitectureWithWheel, { passive: false });
$("#graph-zoom-in").addEventListener("click", () => changeGraphZoom(.15));
$("#graph-zoom-out").addEventListener("click", () => changeGraphZoom(-.15));
$("#graph-reset-view").addEventListener("click", resetGraphView);
$("#trace-overlay-toggle").addEventListener("click", () => {
  if (!currentTrace(state.artifact?.events ?? [])?.trace) return;
  state.traceOverlayEnabled = !state.traceOverlayEnabled;
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
});

$("#panel-evm").addEventListener("click", event => {
  const openStudio = event.target.closest("[data-open-execution-studio]");
  if (openStudio) {
    switchTab("execution", true);
    return;
  }
  const opcodeView = event.target.closest("[data-opcode-view]");
  if (opcodeView) {
    state.opcodeView = opcodeView.dataset.opcodeView;
    renderEvmTrace(currentTrace(state.artifact?.events ?? []));
    return;
  }
  const traceButton = event.target.closest("[data-trace-path]");
  if (!traceButton) return;
  state.selectedTracePath = traceButton.dataset.tracePath;
  if (traceButton.dataset.traceContract) state.selectedContractId = traceButton.dataset.traceContract;
  state.selectedFunctionSelector = traceButton.dataset.traceSelector || null;
  state.functionValues = {};
  resetExecutionState();
  renderEvmTrace(currentTrace(state.artifact?.events ?? []));
});

$("#panel-evm").addEventListener("input", event => {
  if (event.target.id !== "trace-search") return;
  state.traceSearch = event.target.value;
  renderEvmTrace(currentTrace(state.artifact?.events ?? []));
  const input = $("#trace-search");
  input?.focus();
  input?.setSelectionRange(state.traceSearch.length, state.traceSearch.length);
});

$("#panel-evm").addEventListener("change", event => {
  if (event.target.id !== "trace-type") return;
  state.traceType = event.target.value;
  renderEvmTrace(currentTrace(state.artifact?.events ?? []));
});

$("#deployment-graph").addEventListener("keydown", event => {
  if (!["Enter", " "].includes(event.key)) return;
  const group = event.target.closest("[data-architecture-group]");
  if (group) {
    event.preventDefault();
    state.expandedArchitectureGroups = [...new Set([...state.expandedArchitectureGroups, group.dataset.architectureGroup])];
    renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
    return;
  }
  const edge = event.target.closest("[data-edge-id]");
  if (edge) {
    event.preventDefault();
    edge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return;
  }
  const node = event.target.closest("[data-contract-id]");
  if (!node) return;
  event.preventDefault();
  focusArchitectureNode(node.dataset.contractId);
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || state.activeTab !== "architecture" || !state.architectureImmersive) return;
  const next = reduceArchitectureFocus(state, { type: "escape" });
  if (next.focusedNodeId === state.focusedNodeId && next.focusedSection === state.focusedSection && next.focusedAbiItem === state.focusedAbiItem) return;
  Object.assign(state, next);
  if (!state.focusedNodeId) state.focusedEdgeId = null;
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
});

$("#execution-contract-browser").addEventListener("input", event => {
  if (event.target.id !== "execution-search") return;
  state.executionSearch = event.target.value;
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const contract = selectedContract(deployment);
  renderExecutionCatalog(deployment, contract, selectedFunction(contract));
  const input = $("#execution-search");
  input?.focus();
  input?.setSelectionRange(state.executionSearch.length, state.executionSearch.length);
});

$("#execution-contract-browser").addEventListener("click", event => {
  const mode = event.target.closest("[data-execution-mode]");
  if (mode) {
    state.executionFunctionMode = mode.dataset.executionMode;
    const deployment = currentDeployment(state.artifact?.events ?? []);
    const contract = selectedContract(deployment);
    renderExecutionCatalog(deployment, contract, selectedFunction(contract));
    return;
  }
  const contractButton = event.target.closest("[data-execution-contract]");
  if (contractButton) {
    selectArchitectureContract(contractButton.dataset.executionContract);
    return;
  }
  const functionButton = event.target.closest("[data-execution-function]");
  if (!functionButton) return;
  state.selectedFunctionSelector = functionButton.dataset.executionFunction;
  state.functionValues = {};
  resetExecutionState();
  renderDeployment(state.artifact?.events ?? []);
});

$("#execution-workspace").addEventListener("input", event => {
  if (event.target.id === "execution-transaction-hash") {
    state.executionTransactionHash = event.target.value.trim();
    const analyze = $("#inspect-sepolia");
    if (analyze) analyze.disabled = !state.executionTransactionHash || ["simulating", "broadcasting", "confirming", "probing"].includes(state.executionStatus);
    return;
  }
  if (event.target.id === "sepolia-execution-consent") {
    state.executionSepoliaConfirmed = event.target.checked;
    return;
  }
  if (event.target.id === "function-caller") state.functionCaller = event.target.value.trim();
  if (event.target.id === "function-call-value") state.functionCallValue = event.target.value;
  if (event.target.dataset.argumentIndex !== undefined) state.functionValues[Number(event.target.dataset.argumentIndex)] = event.target.value;
});

$("#execution-workspace").addEventListener("change", event => {
  const events = state.artifact?.events ?? [];
  if (event.target.id === "sepolia-execution-consent") state.executionSepoliaConfirmed = event.target.checked;
  if (event.target.id === "execution-transaction-hash") state.executionTransactionHash = event.target.value.trim();
  if (event.target.id === "function-caller") state.functionCaller = event.target.value.trim();
  if (event.target.id === "function-call-value") state.functionCallValue = event.target.value;
  if (event.target.dataset.argumentIndex !== undefined) state.functionValues[Number(event.target.dataset.argumentIndex)] = event.target.value;
  const deployment = currentDeployment(events);
  const contract = selectedContract(deployment);
  renderExecutionWorkspace(contract, selectedFunction(contract), currentTrace(events));
});

$("#execution-workspace").addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.opcodeView) {
    state.opcodeView = button.dataset.opcodeView;
    renderDeployment(state.artifact?.events ?? []);
    return;
  }
  if (button.dataset.probeContract && button.dataset.probeSelector) {
    state.selectedContractId = button.dataset.probeContract;
    state.selectedFunctionSelector = button.dataset.probeSelector;
    state.functionValues = {};
    resetExecutionState();
    renderDeployment(state.artifact?.events ?? []);
    return;
  }
  if (button.id === "restore-example-inputs") {
    state.functionValues = {};
    state.functionCallValue = "0";
    resetExecutionState();
    renderDeployment(state.artifact?.events ?? []);
    return;
  }
  if (button.id === "simulate-execution") runExecutionSimulation();
  if (button.id === "execute-local") runLocalExecution();
  if (button.id === "execute-sepolia") sendSepoliaExecution();
  if (button.id === "inspect-sepolia") inspectSepoliaExecution();
  if (button.id === "probe-contract") runLocalProbe("contract");
  if (button.id === "probe-deployment") runLocalProbe("deployment");
});

function showDeploymentWorkspace(source) {
  if (source === "sepolia") state.traceOverlayEnabled = false;
  const workspace = $("#lab-workspace");
  const deploymentName = source === "sepolia" ? "Verified Sepolia deployment" : "Local deterministic deployment";
  $("#active-deployment-name").textContent = deploymentName;
  $("#architecture-deployment-name").textContent = deploymentName;
  $("#deployment-gateway").hidden = true;
  workspace.hidden = false;
  requestAnimationFrame(() => workspace.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

function chooseDeployment(source) {
  state.deploymentChosen = true;
  state.deploymentSource = source;
  state.activeTab = "architecture";
  state.architectureImmersive = true;
  state.architectureSearch = "";
  state.expandedArchitectureGroups = [];
  state.focusedNodeId = null;
  state.focusedSection = null;
  state.focusedAbiItem = null;
  state.focusedEdgeId = null;
  state.architectureTransactionOpen = false;
  state.selectedContractId = null;
  state.selectedFunctionSelector = null;
  state.selectedAuthorityId = null;
  state.selectedDisclosureId = null;
  state.selectedTracePath = "0";
  state.graphTransform = { x: 0, y: 0, scale: 1 };
  state.graphNodeOffsets = {};
  state.functionCaller = source === "local" ? LOCAL_TEST_SENDER : "";
  resetExecutionState({ global: true });
  showDeploymentWorkspace(source);
  renderDeployment(state.artifact?.events ?? []);
  renderEvmTrace(currentTrace(state.artifact?.events ?? []));
  switchTab("architecture");
}

$$('[data-deployment-choice]').forEach(button => button.addEventListener("click", () => chooseDeployment(button.dataset.deploymentChoice)));

$("#change-deployment").addEventListener("click", () => {
  state.deploymentChosen = false;
  const gateway = $("#deployment-gateway");
  gateway.hidden = false;
  $("#lab-workspace").hidden = true;
  requestAnimationFrame(() => {
    gateway.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    gateway.querySelector("button, select")?.focus();
  });
});

$("#architecture-exit").addEventListener("click", () => {
  state.architectureImmersive = false;
  document.body.classList.remove("architecture-immersive");
  $("#tab-architecture").focus();
});

$("#architecture-search").addEventListener("input", event => {
  state.architectureSearch = event.target.value;
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
  const input = $("#architecture-search");
  input.focus();
  input.setSelectionRange(state.architectureSearch.length, state.architectureSearch.length);
});

for (const [selector, key, renderer] of [
  ["#network-search", "networkSearch", renderNetwork]
]) {
  $(selector).addEventListener("input", event => {
    state[key] = event.target.value;
    if (state.artifact || renderer === renderDeployment) renderer(state.artifact?.events ?? []);
  });
}

for (const [selector, key, renderer] of [
  ["#network-transport", "networkTransport", renderNetwork]
]) {
  $(selector).addEventListener("change", event => {
    state[key] = event.target.value;
    if (state.artifact) renderer(state.artifact.events);
  });
}

async function poll() {
  try {
    const response = await fetch("/api/run", { cache: "no-store" });
    if (response.ok && response.status !== 204) {
      const artifact = await response.json();
      const revision = artifactRevision(artifact);
      if (revision !== state.artifactRevision) {
        state.artifactRevision = revision;
        render(artifact);
      }
    }
  } catch (error) {
    $("#run-summary").textContent = `Lab backend unavailable: ${error.message}`;
  } finally {
    setTimeout(poll, 750);
  }
}

async function loadSepoliaDeployment() {
  try {
    const response = await fetch("/api/deployments/sepolia", { cache: "no-store" });
    state.sepoliaDeployment = await response.json();
  } catch {
    state.sepoliaDeployment = { status: "unavailable" };
  }
  const gatewayStatus = $("#sepolia-choice-status");
  if (state.sepoliaDeployment.status === "verified") {
    gatewayStatus.className = "target-status success";
    gatewayStatus.textContent = "Verified deployment available";
  } else if (state.sepoliaDeployment.status === "mismatch") {
    gatewayStatus.className = "target-status error";
    gatewayStatus.textContent = "Deployment commitments do not match";
  } else {
    gatewayStatus.className = "target-status waiting";
    gatewayStatus.textContent = "Requires a configured Sepolia RPC";
  }
  renderDeployment(state.artifact?.events ?? []);
}

async function loadSepoliaProviders() {
  const select = $("#sepolia-provider");
  try {
    const response = await fetch("/api/deployments/sepolia/providers", { cache: "no-store" });
    if (!response.ok) throw new Error("provider-list-unavailable");
    const payload = await response.json();
    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    select.innerHTML = providers.length ? providers.map((provider, index) => `<option value="${escapeHtml(provider.id)}"${index === 0 ? " selected" : ""}>${escapeHtml(provider.label)} - ${escapeHtml(provider.origin)}</option>`).join("") : `<option value="">No public RPC preset available</option>`;
    $("#connect-sepolia").disabled = providers.length === 0;
  } catch {
    select.innerHTML = `<option value="">Public RPC presets unavailable</option>`;
    $("#connect-sepolia").disabled = true;
  }
}

async function connectSepoliaDeployment() {
  const button = $("#connect-sepolia");
  const status = $("#sepolia-choice-status");
  const provider = $("#sepolia-provider").value;
  if (!provider || button.disabled) return;
  button.disabled = true;
  button.textContent = "Verifying deployment...";
  status.className = "target-status waiting";
  status.textContent = "Checking chain ID and every published runtime code hash";
  try {
    const response = await fetch("/api/deployments/sepolia/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider })
    });
    const report = await response.json();
    state.sepoliaDeployment = report;
    if (!response.ok || report.status !== "verified") {
      const mismatchCount = Array.isArray(report.failures) ? report.failures.length : 0;
      status.className = "target-status error";
      status.textContent = report.status === "mismatch" ? `Verification failed: ${mismatchCount} deployment commitment${mismatchCount === 1 ? "" : "s"} did not match` : (report.message ?? "Public RPC could not verify this deployment");
      renderDeployment(state.artifact?.events ?? []);
      return;
    }
    status.className = "target-status success";
    status.textContent = `${report.checks.length}/${report.checks.length} contracts verified on Sepolia`;
    chooseDeployment("sepolia");
  } catch {
    status.className = "target-status error";
    status.textContent = "Could not reach the selected public RPC";
  } finally {
    button.disabled = false;
    button.textContent = "Connect and verify";
  }
}

$("#connect-sepolia").addEventListener("click", connectSepoliaDeployment);

loadSepoliaProviders();
loadSepoliaDeployment();
poll();
