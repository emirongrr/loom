import { layoutDeploymentGraph } from "./graph-layout.mjs";

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
  graphTransform: { x: 0, y: 0, scale: 1 },
  graphNodeOffsets: {},
  graphInteraction: null,
  ignoreGraphClick: false,
  traceOverlayEnabled: false,
  selectedTracePath: "0",
  traceSearch: "",
  traceType: "all",
  functionValues: {},
  functionCallValue: "0",
  functionCaller: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  executionStatus: "idle",
  executionResult: null,
  executionError: null,
  executionSepoliaConfirmed: false,
  executionTransactionHash: ""
};

const LOCAL_TEST_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const escapeHtml = value => String(value ?? EMPTY).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const format = value => typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
const short = (value, front = 10, back = 8) => value && String(value).length > front + back + 3 ? `${String(value).slice(0, front)}...${String(value).slice(-back)}` : value ?? EMPTY;
const titleCase = value => String(value ?? "").split("-").map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");

function resetExecutionState() {
  state.executionStatus = "idle";
  state.executionResult = null;
  state.executionError = null;
  state.executionSepoliaConfirmed = false;
  state.executionTransactionHash = "";
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
  return state.deploymentSource === "sepolia" ? null : evmTraceEvidence(events);
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

function graphPositions(nodes) {
  const layout = layoutDeploymentGraph(nodes);
  const positions = Object.fromEntries(nodes.map(node => {
    const offset = state.graphNodeOffsets[node.id] ?? { x: 0, y: 0 };
    const base = layout.positions[node.id];
    return [node.id, { x: base.x + offset.x, y: base.y + offset.y }];
  }));
  return { positions, height: layout.height };
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

function renderDeploymentGraph(deployment) {
  const root = $("#deployment-graph");
  if (!deployment?.nodes?.length) {
    root.className = "deployment-graph empty";
    root.textContent = "No deployment evidence is available yet.";
    return;
  }
  root.className = "deployment-graph";
  const { positions, height } = graphPositions(deployment.nodes);
  const nodeHalfWidth = 145;
  const overlay = observedTraceOverlay(deployment, currentTrace(state.artifact?.events ?? []));
  const edges = deployment.edges.map(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) return "";
    if (Math.abs(to.x - from.x) < 20) {
      const direction = to.y >= from.y ? 1 : -1;
      const y1 = from.y + direction * 37;
      const y2 = to.y - direction * 37;
      const middleY = (y1 + y2) / 2;
      return `<g class="graph-edge ${edgeClass(edge.kind)}"><title>${escapeHtml(edge.label)}</title><path d="M ${from.x} ${y1} C ${from.x + 75} ${middleY}, ${to.x + 75} ${middleY}, ${to.x} ${y2}" marker-end="url(#arrow-${edgeClass(edge.kind)})"></path></g>`;
    }
    const x1 = from.x + (to.x >= from.x ? nodeHalfWidth : -nodeHalfWidth);
    const x2 = to.x + (to.x >= from.x ? -nodeHalfWidth : nodeHalfWidth);
    const mid = (x1 + x2) / 2;
    return `<g class="graph-edge ${edgeClass(edge.kind)}"><title>${escapeHtml(edge.label)}</title><path d="M ${x1} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${x2} ${to.y}" marker-end="url(#arrow-${edgeClass(edge.kind)})"></path></g>`;
  }).join("");
  const observedEdges = overlay.edges.map(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) return "";
    const x1 = from.x + (to.x >= from.x ? nodeHalfWidth : -nodeHalfWidth);
    const x2 = to.x + (to.x >= from.x ? -nodeHalfWidth : nodeHalfWidth);
    const mid = (x1 + x2) / 2;
    return `<g class="graph-edge observed"><title>${escapeHtml(`${edge.type} observed ${edge.count} time${edge.count === 1 ? "" : "s"}`)}</title><path d="M ${x1} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${x2} ${to.y}" marker-end="url(#arrow-observed)"></path></g>`;
  }).join("");
  const nodes = deployment.nodes.map(node => {
    const point = positions[node.id];
    const selected = node.id === state.selectedContractId ? " selected" : "";
    const role = ({ core: "CORE", "transport-required": "ERC-4337 TRANSPORT", "profile-required": "ACTIVE PROFILE", optional: "OPTIONAL MODULE", "test-only": "LAB ONLY" })[node.requirement] ?? titleCase(node.requirement);
    const verification = node.verification ? ` · ${node.verification.toUpperCase()}` : "";
    const identityClass = node.id === "LoomAccount" ? " implementation" : node.id === "ObservedAccount" ? " instance" : "";
    const displayName = node.name.length > 28 ? `${node.name.slice(0, 27)}…` : node.name;
    const traceClass = state.traceOverlayEnabled ? overlay.nodeIds.has(node.id) ? " trace-observed" : " trace-idle" : "";
    return `<g class="graph-node ${escapeHtml(node.kind)} ${escapeHtml(node.requirement ?? "optional")}${identityClass}${selected}${traceClass}" data-contract-id="${escapeHtml(node.id)}" role="button" tabindex="0" aria-pressed="${node.id === state.selectedContractId}" aria-label="Inspect ${escapeHtml(node.name)}"><rect x="${point.x - nodeHalfWidth}" y="${point.y - 37}" width="${nodeHalfWidth * 2}" height="74" rx="12"></rect><text class="node-kind" x="${point.x - 125}" y="${point.y - 12}">${escapeHtml(role + verification)}</text><text class="node-name" x="${point.x - 125}" y="${point.y + 10}">${escapeHtml(displayName)}</text><text class="node-address" x="${point.x - 125}" y="${point.y + 29}">${escapeHtml(short(node.address, 10, 8))}</text></g>`;
  }).join("");
  const transform = state.graphTransform;
  root.innerHTML = `<svg viewBox="0 0 1200 ${height}" role="img" aria-label="Loom deployment contract relationship graph"><defs><marker id="arrow-authority" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-call" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-create" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-observed" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs><g class="graph-stage" transform="translate(${transform.x} ${transform.y}) scale(${transform.scale})">${edges}${observedEdges}${nodes}</g></svg>`;
  $("#graph-zoom-level").textContent = `${Math.round(transform.scale * 100)}%`;
  const overlayButton = $("#trace-overlay-toggle");
  const hasTrace = Boolean(currentTrace(state.artifact?.events ?? [])?.trace);
  overlayButton.disabled = !hasTrace;
  overlayButton.setAttribute("aria-pressed", String(state.traceOverlayEnabled && hasTrace));
  overlayButton.textContent = hasTrace ? state.traceOverlayEnabled ? "Hide observed trace" : "Show observed trace" : "Trace unavailable";
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

function selectArchitectureContract(contractId) {
  if (!contractId) return;
  state.selectedContractId = contractId;
  state.selectedFunctionSelector = null;
  state.functionValues = {};
  resetExecutionState();
  renderDeployment(state.artifact?.events ?? []);
}

function beginGraphInteraction(event) {
  if (event.button !== 0) return;
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
  if (selectedNode) selectArchitectureContract(interaction.nodeId);
  if (state.ignoreGraphClick) setTimeout(() => { state.ignoreGraphClick = false; }, 0);
}

function resetGraphView() {
  state.graphTransform = { x: 0, y: 0, scale: 1 };
  state.graphNodeOffsets = {};
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
}

function changeGraphZoom(delta) {
  state.graphTransform.scale = Math.min(1.8, Math.max(.65, Number((state.graphTransform.scale + delta).toFixed(2))));
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
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
  recovery: "Provides optional delayed guardian recovery and validator replacement behavior.",
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

function renderExecutionTrace(trace) {
  const frames = flattenTraceFrames(trace);
  if (!frames.length) return `<p class="empty">This RPC did not provide a call trace.</p>`;
  return `<ol class="execution-trace">${frames.map(frame => `<li style="--execution-depth:${Math.min(frame.depth, 7)}"><span class="trace-type ${escapeHtml(String(frame.type ?? "call").toLowerCase())}">${escapeHtml(frame.type ?? "CALL")}</span><div><strong>${escapeHtml(frame.contractName ?? short(frame.to, 10, 8))}</strong><code>${escapeHtml(traceLabel(frame))}</code></div><small>${escapeHtml(formatTraceNumber(frame.gasUsed))} gas</small><em class="${frame.error ? "error" : "success"}">${frame.error ? "reverted" : "returned"}</em></li>`).join("")}</ol>`;
}

function renderExecutionStateDiff(diff) {
  if (!diff?.accounts?.length) return `<p class="empty">No state changes were reported. The RPC may not expose prestate tracing, or the call did not write state.</p>`;
  return `<div class="execution-state-list">${diff.accounts.map(account => `<article><header><code>${escapeHtml(short(account.address, 12, 10))}</code><span>${account.storage.length} storage slot${account.storage.length === 1 ? "" : "s"}</span></header>${account.balance.before !== account.balance.after ? `<p><strong>Balance</strong><code>${escapeHtml(account.balance.before ?? "unchanged")}</code><i>→</i><code>${escapeHtml(account.balance.after ?? "unchanged")}</code></p>` : ""}${account.nonce.before !== account.nonce.after ? `<p><strong>Nonce</strong><code>${escapeHtml(account.nonce.before ?? "unchanged")}</code><i>→</i><code>${escapeHtml(account.nonce.after ?? "unchanged")}</code></p>` : ""}${account.storage.map(slot => `<p><strong title="${escapeHtml(slot.slot)}">${escapeHtml(short(slot.slot, 10, 8))}</strong><code>${escapeHtml(short(slot.before ?? "empty", 12, 10))}</code><i>→</i><code>${escapeHtml(short(slot.after ?? "empty", 12, 10))}</code></p>`).join("")}</article>`).join("")}${diff.truncated ? `<p class="evidence-note">The state diff exceeded the bounded display limit and was truncated.</p>` : ""}</div>`;
}

function renderExecutionResult(result) {
  if (!result) return "";
  const transaction = result.kind === "transaction";
  const opcodeCounts = Object.entries(result.opcodeProfile?.opcodeCounts ?? {}).sort((left, right) => right[1] - left[1]).slice(0, 16);
  const events = result.events ?? [];
  return `<section class="execution-result" aria-live="polite"><div class="execution-result-heading"><div><p class="eyebrow">${transaction ? "MINED TRANSACTION" : "SIMULATION ONLY"}</p><h2>${result.status === "success" ? transaction ? "Transaction changed chain state" : "Call completed without committing state" : "Execution reverted"}</h2><p>${transaction ? "This result is bound to a mined receipt, not a finality claim. State, events, gas, and trace evidence come from that transaction." : "eth_call and debug_traceCall evaluated the selected inputs at the latest block. No transaction was published and no state was committed."}</p></div><span class="status ${escapeHtml(statusClass(result.status))}">${escapeHtml(result.status)}</span></div><div class="execution-result-metrics">${field("Network", networkLabel(result.chainId))}${field(transaction ? "Transaction" : "Target", transaction ? result.transactionHash : result.contract?.address, { code: true, short: true })}${field("Function", result.function?.signature, { code: true })}${field("Gas used", transaction ? formatTraceNumber(result.gasUsed) : formatTraceNumber(result.trace?.gasUsed), { code: true })}${field("Call frames", result.traceSummary?.calls ?? "Unavailable", { code: true })}${field("Opcode steps", result.opcodeProfile?.totalSteps ?? "Unavailable", { code: true })}</div>${result.revert ? `<div class="execution-revert"><strong>${escapeHtml(result.revert.name ?? "Execution reverted")}</strong><code>${escapeHtml(result.revert.data ?? "No revert data")}</code><p>The revert is part of the result. It often identifies a missing caller, EntryPoint, validator, self-call, timing, or policy precondition.</p></div>` : ""}<div class="execution-result-grid"><section><div class="section-title"><div><p class="eyebrow">INPUT / OUTPUT</p><h3>Encoded call</h3></div></div>${field("Caller", result.transaction?.from ?? "RPC default caller", { code: true, short: true })}${field("Value (wei)", result.transaction?.value ?? "0x0", { code: true })}<details><summary>Calldata</summary>${jsonBlock(result.transaction?.data ?? "0x", "Execution calldata")}</details><details open><summary>Decoded output</summary>${jsonBlock(result.output?.decoded ?? result.output?.raw ?? "No return value", "Execution output")}</details></section><section><div class="section-title"><div><p class="eyebrow">CONTRACT MOVEMENT</p><h3>Call tree</h3></div><span>${escapeHtml(result.capabilities?.callTrace ?? "unavailable")}</span></div>${renderExecutionTrace(result.trace)}</section></div><div class="execution-result-grid"><section><div class="section-title"><div><p class="eyebrow">STORAGE / BALANCE / NONCE</p><h3>State changes</h3></div><span>${escapeHtml(result.capabilities?.stateDiff ?? "unavailable")}</span></div>${renderExecutionStateDiff(result.stateDiff)}</section><section><div class="section-title"><div><p class="eyebrow">OPCODES</p><h3>What the EVM executed</h3></div><span>${escapeHtml(result.capabilities?.opcodeTrace ?? "unavailable")}</span></div>${opcodeCounts.length ? `<div class="execution-opcodes">${opcodeCounts.map(([opcode, count]) => `<span class="${opcodeGroup(opcode)}"><code>${escapeHtml(opcode)}</code><strong>${escapeHtml(count)}</strong></span>`).join("")}</div>` : `<p class="empty">Opcode evidence is unavailable from this RPC.</p>`}<p class="evidence-note">Opcode counts are bounded diagnostic evidence. Stack, memory, and raw storage payloads are not collected.</p></section></div>${transaction ? `<section class="execution-events"><div class="section-title"><div><p class="eyebrow">EVENTS</p><h3>Receipt logs</h3></div><span>${events.length}</span></div>${events.length ? events.map(event => `<article><div><strong>${escapeHtml(event.name ?? "Unknown event")}</strong><code>${escapeHtml(event.contractId ?? short(event.address, 10, 8))}</code></div>${jsonBlock(event.args ?? { topics: event.topics, data: event.data }, "Decoded event")}</article>`).join("") : `<p class="empty">The transaction emitted no logs.</p>`}</section>` : ""}<details class="execution-technical"><summary>Complete execution evidence</summary>${jsonBlock(result, "Execution evidence")}</details></section>`;
}

function renderExecutionWorkspace(contract, fn, tracePayload) {
  const root = $("#execution-workspace");
  if (!contract || !fn) {
    root.className = "surface execution-workspace empty";
    root.textContent = "Select a function to model its inputs and connect future execution evidence.";
    return;
  }
  const inputFields = fn.inputs.map((input, index) => {
    const value = state.functionValues[index] ?? "";
    const validation = validateArgument(input.type, value);
    return `<label class="argument-field"><span>${escapeHtml(input.name || `arg${index}`)} <code>${escapeHtml(input.type)}</code></span><input type="text" data-argument-index="${index}" value="${escapeHtml(value)}" placeholder="${escapeHtml(input.type.endsWith("]") || input.type.startsWith("(") ? "JSON value" : input.type)}" aria-describedby="argument-help-${index}" /><small id="argument-help-${index}" class="${validation.status}">${escapeHtml(validation.text)}</small></label>`;
  }).join("");
  const observedFrames = flattenTrace(tracePayload?.trace).filter(call => call.contractId === contract.id && call.selector === fn.selector);
  const opcodeSteps = tracePayload?.opcodeProfile?.totalSteps;
  const isRead = ["view", "pure"].includes(fn.stateMutability);
  const busy = ["simulating", "broadcasting", "confirming"].includes(state.executionStatus);
  const simulationReady = state.executionResult?.kind === "simulation" && state.executionResult.status === "success";
  const networkName = state.deploymentSource === "sepolia" ? "Verified Sepolia" : "Local Anvil devnet";
  const writeAction = isRead ? "" : state.deploymentSource === "local"
    ? `<button type="button" id="execute-local" class="execution-primary"${busy ? " disabled" : ""}>Execute on local devnet</button>`
    : `<label class="execution-consent"><input type="checkbox" id="sepolia-execution-consent"${state.executionSepoliaConfirmed ? " checked" : ""} /><span><strong>Connected wallet approval</strong>I reviewed the exact target, calldata, value, and Sepolia gas responsibility.</span></label><button type="button" id="execute-sepolia" class="execution-primary"${busy || !simulationReady || !state.executionSepoliaConfirmed ? " disabled" : ""}>Send with connected wallet</button>`;
  const inspectSepolia = state.deploymentSource === "sepolia" && !isRead ? `<div class="execution-import"><label><span>Sepolia transaction hash</span><input id="execution-transaction-hash" value="${escapeHtml(state.executionTransactionHash)}" placeholder="0x..." /></label><button type="button" id="inspect-sepolia"${busy || !state.executionTransactionHash ? " disabled" : ""}>Inspect mined transaction</button></div>` : "";
  root.className = "surface execution-workspace";
  root.innerHTML = `<div class="execution-workspace-heading"><div><p class="eyebrow">EXECUTION WORKSPACE</p><h2>Run, trace, and explain a contract function</h2><p>Try every ABI function against ${escapeHtml(networkName)}. Contract calls, EVM frames, and bounded opcode evidence are correlated without treating simulation as final chain state.</p></div><span class="execution-selection"><strong>${escapeHtml(contract.name)}</strong><code>${escapeHtml(fn.signature)}</code><small>${escapeHtml(networkName)}</small></span></div><div class="execution-workspace-grid"><section class="argument-editor"><div class="section-title"><div><p class="eyebrow">HYPOTHETICAL INPUT</p><h3>Input values</h3><p>Values remain in this browser until you explicitly simulate or publish.</p></div><span>${escapeHtml(fn.stateMutability)}</span></div><div class="execution-input-grid"><label class="argument-field"><span>Caller <code>address</code></span><input type="text" id="function-caller" value="${escapeHtml(state.functionCaller)}" placeholder="Optional eth_call sender" /><small>${state.deploymentSource === "local" ? `Local writes use the fixed Anvil test actor ${short(LOCAL_TEST_SENDER, 8, 6)}.` : "Simulation caller only; the connected wallet controls the real transaction sender."}</small></label><label class="argument-field"><span>Call value <code>uint256 wei</code></span><input type="text" id="function-call-value" value="${escapeHtml(state.functionCallValue)}" inputmode="numeric" /><small>${fn.stateMutability === "payable" ? "This function may receive native value." : "Non-payable functions require zero value."}</small></label>${inputFields || `<p class="empty">This function has no calldata arguments.</p>`}</div><div class="execution-actions"><button type="button" id="simulate-execution"${busy ? " disabled" : ""}>${state.executionStatus === "simulating" ? "Simulating..." : "Simulate without sending"}</button>${writeAction}</div>${state.executionError ? `<div class="execution-error" role="alert"><strong>Execution could not be completed</strong><p>${escapeHtml(state.executionError)}</p></div>` : ""}${inspectSepolia}</section><aside class="execution-evidence"><p class="eyebrow">EVIDENCE MODE</p><h3>${state.executionResult ? state.executionResult.kind === "transaction" ? "Mined transaction evidence" : "Simulation evidence" : observedFrames.length ? `${observedFrames.length} matching recorded frame${observedFrames.length === 1 ? "" : "s"}` : "Ready to simulate"}</h3><p>${state.executionResult ? state.executionResult.kind === "transaction" ? "Receipt-bound evidence may include state changes, logs, gas, call frames, and opcodes depending on RPC capabilities." : "Simulation explains behavior at the latest block but never claims that state changed." : "Choose inputs and simulate first. Write functions can then use the isolated local actor or an explicitly connected Sepolia wallet."}</p><div class="execution-scope"><span>Input + output</span><span>Contract calls</span><span>State diff</span><span>EVM frames</span><span>${opcodeSteps ? `${escapeHtml(opcodeSteps)} recorded opcode steps` : "Opcodes"}</span></div></aside></div>${renderExecutionResult(state.executionResult)}`;
}

function executionRequestBody(contract, fn) {
  return {
    network: state.deploymentSource,
    contractId: contract.id,
    selector: fn.selector,
    args: fn.inputs.map((_, index) => state.functionValues[index] ?? ""),
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

async function inspectSepoliaExecution() {
  const deployment = currentDeployment(state.artifact?.events ?? []);
  const contract = selectedContract(deployment);
  const fn = selectedFunction(contract);
  if (!contract || !fn || state.deploymentSource !== "sepolia" || !state.executionTransactionHash) return;
  await requestExecution("/api/execution/sepolia/inspect", { contractId: contract.id, selector: fn.selector, transactionHash: state.executionTransactionHash }, "confirming");
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

function renderOpcodeExplorer(profile) {
  if (!profile) return `<div class="empty">Opcode-level evidence was not captured.</div>`;
  const counts = Object.entries(profile.opcodeCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, ...counts.map(([, count]) => count));
  const importantSteps = profile.importantSteps ?? [];
  const maxGasCost = importantSteps.reduce((maximum, step) => Math.max(maximum, Number(step.gasCost ?? 0)), 1);
  return `<section class="opcode-explorer"><div class="section-title"><div><p class="eyebrow">OPCODE EXPLORER</p><h2>Opcode explorer</h2></div><span>${escapeHtml(profile.totalSteps)} total steps${profile.truncated ? " / important steps truncated" : ""}</span></div><div class="opcode-layout"><div><h3>Opcode frequency</h3><div class="opcode-frequency">${counts.map(([opcode, count]) => `<div><code>${escapeHtml(opcode)}</code><span><i class="${opcodeGroup(opcode)}" style="width:${Math.max(2, (count / maxCount) * 100)}%"></i></span><strong>${escapeHtml(count)}</strong></div>`).join("")}</div></div><div><h3>Execution movement</h3><div class="opcode-lanes">${importantSteps.map((step, index) => `<article class="opcode-step ${opcodeGroup(step.op)}" style="--opcode-indent:${Math.min(Number(step.depth ?? 0), 6) * .6}rem"><span>${index + 1}</span><strong>${escapeHtml(step.op)}</strong><code>pc ${escapeHtml(step.pc)}</code><code>depth ${escapeHtml(step.depth)}</code><div title="${escapeHtml(step.gasCost)} gas"><i style="width:${Math.max(2, (Number(step.gasCost ?? 0) / maxGasCost) * 100)}%"></i></div><small>${escapeHtml(step.gasCost)} gas</small></article>`).join("")}</div></div></div><div class="opcode-legend"><span class="call">Call</span><span class="read">Read</span><span class="write">Write</span><span class="control">Control</span><span class="crypto">Crypto</span><span class="exit">Exit</span></div><p class="evidence-note">Stack, memory, and storage values are intentionally excluded. The explorer shows bounded control-flow and state-access evidence captured by the local tracer.</p></section>`;
}

function renderEvmTrace(tracePayload) {
  const root = $("#evm-trace");
  const summary = tracePayload?.summary;
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
  renderArchitectureSummary(deployment);
  renderAccountModelExplainer(deployment);
  renderDeploymentGraph(deployment);
  renderContractDossier(deployment, contract);
  renderAbiGroups(contract);
  renderFunctionInspector(contract, fn, tracePayload);
  renderExecutionWorkspace(contract, fn, tracePayload);
  $("#contract-count").textContent = deployment?.nodes?.length ?? 0;
  renderDeploymentVerification();
}

function switchTab(tab, focus = false) {
  state.activeTab = tab;
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
  renderOperationMap(artifact.events);
  renderJourney(artifact);
  renderOperation(artifact.events);
  renderPasskeyProof(artifact.events);
  renderNetwork(artifact.events);
  renderDeployment(artifact.events);
  renderEvmTrace(currentTrace(artifact.events));
  if (state.deploymentSource === "sepolia") {
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
  if (button) switchTab(button.dataset.tab, true);
});

$(".workspace-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = $$('[role="tab"]');
  const current = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  switchTab(tabs[next].dataset.tab, true);
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

$("#operation-map").addEventListener("click", event => {
  const button = event.target.closest("[data-open-network-operation]");
  if (!button || !state.artifact) return;
  state.selectedNetworkOperation = button.dataset.openNetworkOperation;
  state.selectedNetworkIndex = 0;
  renderNetwork(state.artifact.events);
  switchTab("network", true);
});

$("#panel-architecture").addEventListener("click", event => {
  const events = state.artifact?.events ?? [];
  if (state.ignoreGraphClick && event.target.closest("#deployment-graph")) {
    state.ignoreGraphClick = false;
    return;
  }
  const contractButton = event.target.closest("[data-contract-id]");
  if (contractButton) {
    selectArchitectureContract(contractButton.dataset.contractId);
    return;
  }
  const functionButton = event.target.closest("[data-function-selector]");
  if (functionButton) {
    state.selectedFunctionSelector = functionButton.dataset.functionSelector;
    state.functionValues = {};
    resetExecutionState();
    renderDeployment(events);
    return;
  }
});

$("#deployment-graph").addEventListener("pointerdown", beginGraphInteraction);
$("#deployment-graph").addEventListener("pointermove", moveGraphInteraction);
$("#deployment-graph").addEventListener("pointerup", endGraphInteraction);
$("#deployment-graph").addEventListener("pointercancel", endGraphInteraction);
$("#graph-zoom-in").addEventListener("click", () => changeGraphZoom(.15));
$("#graph-zoom-out").addEventListener("click", () => changeGraphZoom(-.15));
$("#graph-reset-view").addEventListener("click", resetGraphView);
$("#trace-overlay-toggle").addEventListener("click", () => {
  if (!currentTrace(state.artifact?.events ?? [])?.trace) return;
  state.traceOverlayEnabled = !state.traceOverlayEnabled;
  renderDeploymentGraph(currentDeployment(state.artifact?.events ?? []));
});

$("#panel-evm").addEventListener("click", event => {
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
  const node = event.target.closest("[data-contract-id]");
  if (!node) return;
  event.preventDefault();
  selectArchitectureContract(node.dataset.contractId);
});

$("#execution-workspace").addEventListener("input", event => {
  if (event.target.id === "execution-transaction-hash") {
    state.executionTransactionHash = event.target.value.trim();
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
  if (button.id === "simulate-execution") runExecutionSimulation();
  if (button.id === "execute-local") runLocalExecution();
  if (button.id === "execute-sepolia") sendSepoliaExecution();
  if (button.id === "inspect-sepolia") inspectSepoliaExecution();
});

function showDeploymentWorkspace(source) {
  if (source === "sepolia") state.traceOverlayEnabled = false;
  const workspace = $("#lab-workspace");
  $("#active-deployment-name").textContent = source === "sepolia" ? "Verified Sepolia deployment" : "Local deterministic deployment";
  $("#deployment-gateway").hidden = true;
  workspace.hidden = false;
  requestAnimationFrame(() => workspace.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

function chooseDeployment(source) {
  state.deploymentChosen = true;
  state.deploymentSource = source;
  state.activeTab = "architecture";
  state.selectedContractId = null;
  state.selectedFunctionSelector = null;
  state.selectedTracePath = "0";
  state.graphTransform = { x: 0, y: 0, scale: 1 };
  state.graphNodeOffsets = {};
  state.functionCaller = source === "local" ? LOCAL_TEST_SENDER : "";
  resetExecutionState();
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

for (const [selector, key, renderer] of [
  ["#network-search", "networkSearch", renderNetwork],
  ["#function-search", "functionSearch", renderDeployment]
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
      status.textContent = report.status === "mismatch" ? `Verification failed: ${mismatchCount} deployment commitment${mismatchCount === 1 ? "" : "s"} did not match` : "Public RPC could not verify this deployment";
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
