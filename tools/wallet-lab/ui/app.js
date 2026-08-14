const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const EMPTY = "-";
const state = {
  artifact: null,
  activeTab: "overview",
  selectedSpanId: null,
  selectedNetworkIndex: 0,
  timelineSearch: "",
  timelineComponent: "all",
  timelineStatus: "all",
  networkSearch: "",
  networkTransport: "all"
};

const escapeHtml = value => String(value ?? EMPTY).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const format = value => typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
const short = (value, front = 10, back = 8) => value && String(value).length > front + back + 3 ? `${String(value).slice(0, front)}...${String(value).slice(-back)}` : value ?? EMPTY;
const titleCase = value => String(value ?? "").split("-").map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");

function statusClass(status) {
  if (["success", "finalized", "confirmed", "included", "pass", "healthy"].includes(status)) return "success";
  if (["error", "reverted", "dropped", "reorganized", "fail", "unhealthy"].includes(status)) return "error";
  return "waiting";
}

function duration(artifact) {
  if (!artifact?.finishedAt) return "Live";
  const elapsed = Math.max(0, new Date(artifact.finishedAt) - new Date(artifact.startedAt));
  return elapsed < 1_000 ? `${elapsed} ms` : `${(elapsed / 1_000).toFixed(1)} s`;
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

function renderInvariants(values = []) {
  const root = $("#invariants");
  if (!values.length) {
    root.className = "invariants empty";
    root.textContent = "No invariant results yet.";
    return;
  }
  root.className = "invariants";
  root.innerHTML = values.map(value => `<article class="${statusClass(value.status)}"><div><strong>${escapeHtml(value.id)}</strong><span>${escapeHtml(value.status)}</span></div><p>${escapeHtml(value.explanation)}</p></article>`).join("");
}

function eventMatches(event) {
  const haystack = [event.phase, event.component, event.status, event.explanation, event.userOpHash, event.transactionHash].join(" ").toLowerCase();
  return (state.timelineComponent === "all" || event.component === state.timelineComponent)
    && (state.timelineStatus === "all" || event.status === state.timelineStatus)
    && (!state.timelineSearch || haystack.includes(state.timelineSearch.toLowerCase()));
}

function populateSelect(selector, values, initial) {
  const select = $(selector);
  const first = select.options[0]?.outerHTML ?? "";
  select.innerHTML = first + [...new Set(values)].sort().map(value => `<option value="${escapeHtml(value)}">${escapeHtml(titleCase(value))}</option>`).join("");
  select.value = initial;
}

function renderTimeline(events = []) {
  const filtered = events.filter(eventMatches);
  const root = $("#timeline");
  const selected = events.find(event => event.spanId === state.selectedSpanId) ?? filtered[0] ?? events[0];
  if (selected && selected.spanId !== state.selectedSpanId) state.selectedSpanId = selected.spanId;
  if (!filtered.length) {
    root.innerHTML = `<li class="empty">No lifecycle stages match these filters.</li>`;
  } else {
    root.innerHTML = filtered.map(event => `<li class="event ${statusClass(event.status)}"><button type="button" class="event-button${event.spanId === state.selectedSpanId ? " selected" : ""}" data-span-id="${escapeHtml(event.spanId)}"><span class="event-marker">${escapeHtml(event.monotonicSequence)}</span><span class="event-copy"><span class="event-head"><strong>${escapeHtml(titleCase(event.phase))}</strong><span class="pill">${escapeHtml(event.status)}</span></span><span class="event-meta">${escapeHtml(event.component)} / ${escapeHtml(event.durationMs === undefined ? "live" : `${event.durationMs} ms`)}</span><span class="event-explanation">${escapeHtml(event.explanation)}</span></span></button></li>`).join("");
  }
  renderEventInspector(selected);
}

function renderEventInspector(event) {
  const root = $("#event-inspector");
  if (!event) {
    root.className = "surface inspector-detail empty";
    root.textContent = "Select a lifecycle stage to inspect its evidence.";
    return;
  }
  root.className = "surface inspector-detail";
  root.innerHTML = `<div class="inspector-heading"><div><p class="eyebrow">STAGE ${escapeHtml(event.monotonicSequence)}</p><h2>${escapeHtml(titleCase(event.phase))}</h2></div><span class="status ${statusClass(event.status)}">${escapeHtml(event.status)}</span></div><p class="lead">${escapeHtml(event.explanation)}</p><div class="evidence-grid">${field("Component", event.component)}${field("Duration", event.durationMs === undefined ? "Live" : `${event.durationMs} ms`)}${event.userOpHash ? field("UserOperation hash", event.userOpHash, { code: true, short: true }) : ""}${event.transactionHash ? field("Transaction hash", event.transactionHash, { code: true, short: true }) : ""}${event.blockNumber !== undefined ? field("Block", event.blockNumber, { code: true }) : ""}${event.source ? field("Source", `${event.source.file}${event.source.symbol ? `:${event.source.symbol}` : ""}`, { code: true }) : ""}</div>${event.reproduction ? `<div class="callout"><span>Reproduce</span><code>${escapeHtml(event.reproduction)}</code></div>` : ""}<details open><summary>Stage payload</summary>${jsonBlock(event.payload, `${event.phase} payload`)}</details>`;
}

function richestUserOperationEvent(events) {
  return [...events].reverse().find(event => event.payload?.userOperation && event.payload?.packedUserOperation)
    ?? [...events].reverse().find(event => event.payload?.unpacked)
    ?? [...events].reverse().find(event => event.payload?.userOperation);
}

function renderUserOperation(events = []) {
  const root = $("#userop-inspector");
  const event = richestUserOperationEvent(events);
  if (!event) {
    root.className = "empty-state";
    root.textContent = "No signed UserOperation evidence is available yet.";
    return;
  }
  const payload = event.payload ?? {};
  const operation = payload.userOperation ?? payload.unpacked ?? {};
  const packed = payload.packedUserOperation ?? payload.packed ?? null;
  const independent = payload.independentHash ?? payload.independentlyComputedHash ?? payload.userOpHash;
  const bundlerHash = payload.bundlerHash ?? event.userOpHash;
  const hashMatch = Boolean(independent && bundlerHash && String(independent).toLowerCase() === String(bundlerHash).toLowerCase());
  const gas = [
    ["Call gas", operation.callGasLimit],
    ["Verification gas", operation.verificationGasLimit],
    ["Pre-verification gas", operation.preVerificationGas],
    ["Max fee / gas", operation.maxFeePerGas],
    ["Priority fee / gas", operation.maxPriorityFeePerGas]
  ];
  root.className = "inspector-stack";
  root.innerHTML = `<article class="surface hero-inspector"><div class="inspector-heading"><div><p class="eyebrow">ERC-4337 OPERATION</p><h2>Signed UserOperation</h2><p>${escapeHtml(event.explanation)}</p></div><span class="status ${hashMatch ? "success" : "waiting"}">${hashMatch ? "Hash verified" : "Hash pending"}</span></div><div class="evidence-grid primary-fields">${field("Sender", operation.sender ?? event.account, { code: true, short: true })}${field("Nonce", operation.nonce, { code: true })}${field("EntryPoint", event.entryPoint, { code: true, short: true })}${field("Chain ID", event.chainId, { code: true })}</div></article><div class="inspector-columns"><article class="surface"><div class="section-title"><div><p class="eyebrow">PROVENANCE</p><h2>Hashes and signature</h2></div></div><div class="stacked-fields">${field("Independent hash", independent, { code: true, short: true })}${field("Bundler hash", bundlerHash, { code: true, short: true })}${field("Signature envelope bytes", operation.signature ? Math.max(0, (String(operation.signature).length - 2) / 2) : EMPTY, { code: true })}${field("Factory", operation.factory ?? (operation.initCode && operation.initCode !== "0x" ? short(operation.initCode) : "Already deployed"), { code: true, short: true })}${field("Paymaster", operation.paymaster ?? "Account funded", { code: true, short: true })}</div></article><article class="surface"><div class="section-title"><div><p class="eyebrow">SIMULATION INPUT</p><h2>Gas and fee limits</h2></div></div><div class="stacked-fields">${gas.map(([label, value]) => field(label, value ?? EMPTY, { code: true })).join("")}</div></article></div><article class="surface"><details open><summary>Unpacked operation</summary>${jsonBlock(operation, "Unpacked UserOperation")}</details>${packed ? `<details><summary>Packed operation</summary>${jsonBlock(packed, "Packed UserOperation")}</details>` : ""}</article>`;
}

function richestWebAuthnEvent(events) {
  return [...events].reverse().find(event => event.phase === "webauthn" && (event.payload?.clientDataJSON || event.payload?.r || event.payload?.authenticatorData))
    ?? [...events].reverse().find(event => event.phase === "webauthn");
}

function parseClientData(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function renderWebAuthn(events = []) {
  const root = $("#webauthn-inspector");
  const event = richestWebAuthnEvent(events);
  if (!event) {
    root.className = "empty-state";
    root.textContent = "No WebAuthn evidence is available yet.";
    return;
  }
  const data = event.payload ?? {};
  const clientData = parseClientData(data.clientDataJSON);
  const flags = data.flags && typeof data.flags === "object" ? data.flags : {};
  root.className = "inspector-stack";
  root.innerHTML = `<article class="surface hero-inspector"><div class="inspector-heading"><div><p class="eyebrow">PASSKEY ASSERTION</p><h2>WebAuthn verification inputs</h2><p>${escapeHtml(event.explanation)}</p></div><span class="status ${statusClass(event.status)}">${escapeHtml(event.status)}</span></div><div class="evidence-grid primary-fields">${field("RP ID", data.rpId)}${field("Origin", data.origin, { code: true })}${field("Credential ID", data.credentialId, { code: true, short: true })}${field("Ceremonies", data.assertedCeremonies ?? 1, { code: true })}</div></article><div class="inspector-columns"><article class="surface"><div class="section-title"><div><p class="eyebrow">AUTHENTICATOR</p><h2>Presence and verification</h2></div></div><div class="stacked-fields">${field("User present", flags.up ?? flags.userPresent ?? "Recorded in authenticator data")}${field("User verified", flags.uv ?? flags.userVerified ?? data.userVerification ?? "Recorded in authenticator data")}${field("Signature counter", data.signCount ?? EMPTY, { code: true })}${field("Encoding", data.signatureEncoding ?? "P-256 WebAuthn", { code: true })}${field("Private material stored", data.credentialMaterialStored ?? false)}</div></article><article class="surface"><div class="section-title"><div><p class="eyebrow">CHALLENGE BINDING</p><h2>Client and RP evidence</h2></div></div><div class="stacked-fields">${field("Challenge", data.challenge ?? clientData?.challenge ?? EMPTY, { code: true, short: true })}${field("RP ID hash", data.rpIdHash ?? EMPTY, { code: true, short: true })}${field("Client type", clientData?.type ?? EMPTY, { code: true })}${field("Cross origin", clientData?.crossOrigin ?? false)}</div></article></div><article class="surface"><div class="section-title"><div><p class="eyebrow">P-256 SIGNATURE</p><h2>Canonical components</h2></div></div><div class="evidence-grid">${field("r", data.r ?? EMPTY, { code: true, short: true })}${field("s", data.s ?? EMPTY, { code: true, short: true })}${field("UserOperation hash", data.userOpHash ?? event.userOpHash ?? EMPTY, { code: true, short: true })}</div><details><summary>Raw WebAuthn evidence</summary>${jsonBlock(data, "WebAuthn evidence")}</details></article>`;
}

function networkExchanges(events = []) {
  return events.flatMap(event => event.phase === "network" && Array.isArray(event.payload?.exchanges)
    ? event.payload.exchanges.map((exchange, index) => ({ ...exchange, evidenceSpanId: event.spanId, index }))
    : []);
}

function filteredNetwork(events) {
  return networkExchanges(events).filter(exchange => {
    const method = exchange.request?.method ?? "unknown";
    return (state.networkTransport === "all" || exchange.transport === state.networkTransport)
      && (!state.networkSearch || method.toLowerCase().includes(state.networkSearch.toLowerCase()));
  });
}

function renderNetwork(events = []) {
  const exchanges = filteredNetwork(events);
  const rows = $("#network-rows");
  if (!exchanges.length) {
    rows.innerHTML = `<tr><td colspan="5" class="empty">No captured JSON-RPC exchanges match these filters.</td></tr>`;
    renderNetworkInspector(null);
    return;
  }
  if (state.selectedNetworkIndex >= exchanges.length) state.selectedNetworkIndex = 0;
  rows.innerHTML = exchanges.map((exchange, index) => {
    const responseState = exchange.response?.error ? "error" : exchange.response?.result !== undefined ? "success" : "waiting";
    return `<tr class="${index === state.selectedNetworkIndex ? "selected" : ""}"><td><button type="button" data-network-index="${index}" aria-label="Inspect ${escapeHtml(exchange.request?.method ?? "request")}">${index + 1}</button></td><td><span class="transport ${escapeHtml(exchange.transport ?? "rpc")}">${escapeHtml(exchange.transport ?? "rpc")}</span></td><td><code>${escapeHtml(exchange.request?.method ?? "unknown")}</code></td><td>${escapeHtml(exchange.status ?? EMPTY)}</td><td><span class="pill ${statusClass(responseState)}">${responseState}</span></td></tr>`;
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
  root.innerHTML = `<div class="inspector-heading"><div><p class="eyebrow">${escapeHtml(exchange.transport ?? "rpc")}</p><h2>${escapeHtml(exchange.request?.method ?? "Unknown request")}</h2></div><span class="status ${responseState}">${exchange.response?.error ? "Rejected" : "Returned"}</span></div><div class="evidence-grid">${field("HTTP status", exchange.status ?? EMPTY, { code: true })}${field("Request ID", exchange.request?.id ?? EMPTY, { code: true })}${field("Endpoint", exchange.endpoint ?? EMPTY, { code: true, short: true })}</div><div class="json-compare"><div><h3>Request</h3>${jsonBlock(exchange.request, "JSON-RPC request")}</div><div><h3>Response</h3>${jsonBlock(exchange.response, "JSON-RPC response")}</div></div>`;
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
  state.artifact = artifact;
  $("#run-summary").textContent = `${artifact.scenario?.title ?? artifact.scenarioId} / ${artifact.runId}`;
  const status = $("#run-status");
  status.textContent = artifact.status;
  status.className = `status ${statusClass(artifact.status)}`;
  $("#metric-scenario").textContent = artifact.scenarioId;
  $("#metric-chain").textContent = artifact.environment?.chainId ?? EMPTY;
  $("#metric-events").textContent = artifact.events.length;
  $("#metric-duration").textContent = duration(artifact);
  $("#metric-redaction").textContent = artifact.redaction.level;
  $("#timeline-count").textContent = artifact.events.length;
  $("#network-count").textContent = networkExchanges(artifact.events).length;
  $("#updated-at").textContent = artifact.finishedAt ? `Finished ${new Date(artifact.finishedAt).toLocaleTimeString()}` : "Live";
  renderEnvironment(artifact.environment);
  renderState(artifact.stateDiff);
  renderInvariants(artifact.invariants);
  $("#replay").textContent = `${artifact.replay.command}\nseed=${artifact.replay.seed}\nschema=${artifact.schema}@${artifact.version}\nredaction=${artifact.redaction.level}`;
  populateSelect("#timeline-component", artifact.events.map(event => event.component), state.timelineComponent);
  populateSelect("#timeline-status", artifact.events.map(event => event.status), state.timelineStatus);
  renderTimeline(artifact.events);
  renderUserOperation(artifact.events);
  renderWebAuthn(artifact.events);
  renderNetwork(artifact.events);
  if (artifact.firstFailingBoundary) {
    $("#failure-panel").hidden = false;
    $("#failure").textContent = `${artifact.firstFailingBoundary}: inspect the earliest error stage in Timeline.`;
  } else {
    $("#failure-panel").hidden = true;
  }
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

$("#timeline").addEventListener("click", event => {
  const button = event.target.closest("[data-span-id]");
  if (!button || !state.artifact) return;
  state.selectedSpanId = button.dataset.spanId;
  renderTimeline(state.artifact.events);
});

$("#network-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-network-index]");
  if (!button || !state.artifact) return;
  state.selectedNetworkIndex = Number(button.dataset.networkIndex);
  renderNetwork(state.artifact.events);
});

for (const [selector, key, renderer] of [
  ["#timeline-search", "timelineSearch", renderTimeline],
  ["#network-search", "networkSearch", renderNetwork]
]) {
  $(selector).addEventListener("input", event => {
    state[key] = event.target.value;
    if (state.artifact) renderer(state.artifact.events);
  });
}

for (const [selector, key, renderer] of [
  ["#timeline-component", "timelineComponent", renderTimeline],
  ["#timeline-status", "timelineStatus", renderTimeline],
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
    if (response.ok && response.status !== 204) render(await response.json());
  } catch (error) {
    $("#run-summary").textContent = `Lab backend unavailable: ${error.message}`;
  } finally {
    setTimeout(poll, 750);
  }
}

poll();
