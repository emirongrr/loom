const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const EMPTY = "-";
const state = {
  artifact: null,
  sepoliaDeployment: null,
  deploymentSource: "local",
  activeTab: "overview",
  selectedSpanId: null,
  selectedNetworkIndex: 0,
  timelineSearch: "",
  timelineComponent: "all",
  timelineStatus: "all",
  networkSearch: "",
  networkTransport: "all",
  contractSearch: "",
  functionSearch: "",
  selectedContractId: null,
  selectedFunctionSelector: null,
  functionValues: {},
  functionCallValue: "0"
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

function graphPositions(nodes) {
  const positions = {};
  const left = nodes.filter(node => ["protocol", "factory", "recovery"].includes(node.kind));
  const center = nodes.filter(node => node.kind === "account");
  const right = nodes.filter(node => !left.includes(node) && !center.includes(node));
  const place = (group, x, height) => group.forEach((node, index) => {
    positions[node.id] = { x, y: 42 + ((index + 1) * (height - 84)) / (group.length + 1) };
  });
  place(left, 130, 520);
  place(center, 530, 520);
  place(right, 930, 520);
  return positions;
}

function edgeClass(kind) {
  if (["validates-with", "guarded-by", "recovers", "optional-validator", "optional-hook"].includes(kind)) return "authority";
  if (["creates", "delegates", "provisions-for"].includes(kind)) return "create";
  return "call";
}

function renderDeploymentGraph(deployment) {
  const root = $("#deployment-graph");
  if (!deployment?.nodes?.length) {
    root.className = "deployment-graph empty";
    root.textContent = "No deployment evidence is available yet.";
    return;
  }
  root.className = "deployment-graph";
  const positions = graphPositions(deployment.nodes);
  const edges = deployment.edges.map(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) return "";
    const x1 = from.x + 130;
    const x2 = to.x - 130;
    const mid = (x1 + x2) / 2;
    return `<g class="graph-edge ${edgeClass(edge.kind)}"><title>${escapeHtml(edge.label)}</title><path d="M ${x1} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${x2} ${to.y}" marker-end="url(#arrow-${edgeClass(edge.kind)})"></path></g>`;
  }).join("");
  const nodes = deployment.nodes.map(node => {
    const point = positions[node.id];
    const selected = node.id === state.selectedContractId ? " selected" : "";
    const verification = node.verification ? ` / ${node.verification}` : "";
    return `<g class="graph-node ${escapeHtml(node.kind)}${selected}" data-contract-id="${escapeHtml(node.id)}" role="button" tabindex="0" aria-label="Inspect ${escapeHtml(node.name)}"><rect x="${point.x - 130}" y="${point.y - 34}" width="260" height="68" rx="12"></rect><text class="node-kind" x="${point.x - 112}" y="${point.y - 10}">${escapeHtml(node.kind.toUpperCase() + verification.toUpperCase())}</text><text class="node-name" x="${point.x - 112}" y="${point.y + 10}">${escapeHtml(node.name)}</text><text class="node-address" x="${point.x - 112}" y="${point.y + 27}">${escapeHtml(short(node.address, 8, 6))}</text></g>`;
  }).join("");
  root.innerHTML = `<svg viewBox="0 0 1200 520" role="img" aria-label="Loom deployment contract relationship graph"><defs><marker id="arrow-authority" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-call" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker><marker id="arrow-create" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs>${edges}${nodes}</svg>`;
}

function renderRelationshipSummary(deployment, contract) {
  const root = $("#relationship-summary");
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

function renderContractList(deployment) {
  const root = $("#contract-list");
  const query = state.contractSearch.toLowerCase();
  const nodes = (deployment?.nodes ?? []).filter(node => !query || `${node.name} ${node.kind} ${node.address}`.toLowerCase().includes(query));
  if (!nodes.length) {
    root.className = "contract-list empty";
    root.textContent = "No contracts match this filter.";
    return;
  }
  root.className = "contract-list";
  root.innerHTML = nodes.map(node => `<button type="button" class="catalog-item${node.id === state.selectedContractId ? " selected" : ""}" data-contract-id="${escapeHtml(node.id)}"><span class="catalog-icon ${escapeHtml(node.kind)}">${escapeHtml(node.name.slice(0, 1))}</span><span><strong>${escapeHtml(node.name)}</strong><code>${escapeHtml(short(node.address, 8, 6))}</code></span><small>${node.verification ? escapeHtml(node.verification) : `${escapeHtml(node.functions.length)} fn`}</small></button>`).join("");
}

function renderFunctionList(contract) {
  const root = $("#function-list");
  if (!contract) {
    root.className = "function-list empty";
    root.textContent = "Select a contract.";
    return;
  }
  $("#contract-heading").innerHTML = `<div><p class="eyebrow">ABI SURFACE</p><h2>${escapeHtml(contract.name)}</h2><code>${escapeHtml(short(contract.address, 10, 8))}</code></div><span>${escapeHtml(contract.functions.length)} functions</span>`;
  const query = state.functionSearch.toLowerCase();
  const functions = contract.functions.filter(fn => !query || `${fn.signature} ${fn.stateMutability} ${fn.selector}`.toLowerCase().includes(query));
  if (!functions.length) {
    root.className = "function-list empty";
    root.textContent = "No functions match this filter.";
    return;
  }
  root.className = "function-list";
  root.innerHTML = functions.map(fn => `<button type="button" class="function-item${fn.selector === state.selectedFunctionSelector ? " selected" : ""}" data-function-selector="${escapeHtml(fn.selector)}"><span><strong>${escapeHtml(fn.name)}</strong><code>${escapeHtml(fn.signature)}</code></span><span class="mutability ${escapeHtml(fn.stateMutability)}">${escapeHtml(fn.stateMutability)}</span></button>`).join("");
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

function renderFunctionInspector(contract, fn, tracePayload) {
  const root = $("#function-inspector");
  if (!contract || !fn) {
    root.className = "surface function-inspector empty";
    root.textContent = "Select a function to inspect its parameters and EVM behavior.";
    return;
  }
  root.className = "surface function-inspector";
  const inputFields = fn.inputs.map((input, index) => {
    const value = state.functionValues[index] ?? "";
    const validation = validateArgument(input.type, value);
    return `<label class="argument-field"><span>${escapeHtml(input.name || `arg${index}`)} <code>${escapeHtml(input.type)}</code></span><input type="text" data-argument-index="${index}" value="${escapeHtml(value)}" placeholder="${escapeHtml(input.type.endsWith("]") || input.type.startsWith("(") ? "JSON value" : input.type)}" aria-describedby="argument-help-${index}" /><small id="argument-help-${index}" class="${validation.status}">${escapeHtml(validation.text)}</small></label>`;
  }).join("");
  const steps = behaviorSteps(fn, contract, tracePayload);
  root.innerHTML = `<div class="inspector-heading"><div><p class="eyebrow">FUNCTION BEHAVIOR</p><h2>${escapeHtml(fn.name)}</h2><code>${escapeHtml(fn.signature)}</code></div><span class="mutability ${escapeHtml(fn.stateMutability)}">${escapeHtml(fn.stateMutability)}</span></div><p class="lead">${escapeHtml(fn.behavior)}</p><div class="selector-line">${field("Contract", contract.address, { code: true, short: true })}${field("Selector", fn.selector, { code: true })}${field("Outputs", fn.outputs.length ? fn.outputs.map(output => output.type).join(", ") : "none", { code: true })}</div><div class="argument-editor"><div class="section-title"><div><p class="eyebrow">HYPOTHETICAL INPUT</p><h2>Values</h2></div><span>Preview only - never broadcast</span></div><label class="argument-field"><span>Call value <code>uint256 wei</code></span><input type="text" id="function-call-value" value="${escapeHtml(state.functionCallValue)}" inputmode="numeric" /><small>${fn.stateMutability === "payable" ? "This function may receive native value." : "Non-payable functions require zero value."}</small></label>${inputFields || `<p class="empty">This function has no calldata arguments.</p>`}</div><div class="behavior-flow">${steps.map((step, index) => `<article class="behavior-step ${step.status}"><span>${index + 1}</span><div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.text)}</p></div></article>`).join("")}</div><div class="call-shape"><span>Call shape</span><code>${escapeHtml(contract.address)} . ${escapeHtml(fn.selector)} + ABI.encode(${escapeHtml(fn.inputs.map(input => input.name || input.type).join(", "))})</code></div>`;
}

function renderTraceNode(node) {
  const label = node.functionSignature ?? (node.selector && node.selector !== "0x" ? node.selector : "fallback / receive");
  return `<li><button type="button" class="trace-frame${node.error ? " error" : ""}" data-trace-contract="${escapeHtml(node.contractId ?? "")}" data-trace-selector="${escapeHtml(node.selector ?? "")}"><span class="trace-op">${escapeHtml(node.type)}</span><span><strong>${escapeHtml(node.contractName ?? short(node.to, 8, 6))}</strong><code>${escapeHtml(label)}</code></span><span class="trace-gas">${escapeHtml(node.gasUsed ?? EMPTY)} gas</span>${node.error ? `<span class="trace-error">${escapeHtml(node.error)}</span>` : ""}</button>${node.calls?.length ? `<ol>${node.calls.map(renderTraceNode).join("")}</ol>` : ""}</li>`;
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
  $("#evm-trace-summary").textContent = `${summary.calls} frames / depth ${summary.maxDepth} / ${summary.errors} errors`;
  const profile = tracePayload.opcodeProfile;
  const importantCounts = profile ? Object.entries(profile.opcodeCounts ?? {}).filter(([op]) => ["CALL", "STATICCALL", "DELEGATECALL", "SLOAD", "SSTORE", "KECCAK256", "REVERT", "RETURN"].includes(op)) : [];
  root.innerHTML = `<div class="trace-provenance">${field("Transaction", tracePayload.transactionHash, { code: true, short: true })}${field("Tracer", tracePayload.method, { code: true })}${field("Frame types", Object.entries(summary.opcodes ?? {}).map(([type, count]) => `${type} ${count}`).join(" / "), { code: true })}</div><ol class="trace-tree">${renderTraceNode(tracePayload.trace)}</ol>${profile ? `<section class="opcode-section"><div class="section-title"><div><p class="eyebrow">BOUNDED OPCODE EVIDENCE</p><h2>EVM movement</h2></div><span>${escapeHtml(profile.totalSteps)} total steps${profile.truncated ? " / important steps truncated" : ""}</span></div><div class="opcode-counts">${importantCounts.map(([op, count]) => `<span><strong>${escapeHtml(op)}</strong>${escapeHtml(count)}</span>`).join("")}</div><div class="opcode-steps">${profile.importantSteps.map(step => `<article><span class="opcode-name">${escapeHtml(step.op)}</span><code>pc ${escapeHtml(step.pc)}</code><code>depth ${escapeHtml(step.depth)}</code><code>gas cost ${escapeHtml(step.gasCost)}</code></article>`).join("")}</div><p class="evidence-note">Stack, memory, and storage values are intentionally excluded. This panel proves control-flow and state-access opcodes without serializing execution internals into the artifact.</p></section>` : ""}`;
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
  renderRelationshipSummary(deployment, contract);
  renderContractList(deployment);
  renderFunctionList(contract);
  renderFunctionInspector(contract, fn, tracePayload);
  renderEvmTrace(tracePayload);
  if (state.deploymentSource === "sepolia" && !tracePayload) {
    $("#evm-trace").textContent = "Sepolia contracts are connected read-only. Select the local run to inspect a captured transaction trace.";
  }
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
  $("#contract-count").textContent = currentDeployment(artifact.events)?.nodes?.length ?? 0;
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
  renderDeployment(artifact.events);
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

$("#panel-deployment").addEventListener("click", event => {
  const events = state.artifact?.events ?? [];
  const contractButton = event.target.closest("[data-contract-id]");
  if (contractButton) {
    state.selectedContractId = contractButton.dataset.contractId;
    state.selectedFunctionSelector = null;
    state.functionValues = {};
    renderDeployment(events);
    return;
  }
  const functionButton = event.target.closest("[data-function-selector]");
  if (functionButton) {
    state.selectedFunctionSelector = functionButton.dataset.functionSelector;
    state.functionValues = {};
    renderDeployment(events);
    return;
  }
  const traceButton = event.target.closest("[data-trace-contract]");
  if (traceButton?.dataset.traceContract) {
    state.selectedContractId = traceButton.dataset.traceContract;
    state.selectedFunctionSelector = traceButton.dataset.traceSelector || null;
    state.functionValues = {};
    renderDeployment(events);
  }
});

$("#deployment-graph").addEventListener("keydown", event => {
  if (!["Enter", " "].includes(event.key)) return;
  const node = event.target.closest("[data-contract-id]");
  if (!node) return;
  event.preventDefault();
  state.selectedContractId = node.dataset.contractId;
  state.selectedFunctionSelector = null;
  state.functionValues = {};
  renderDeployment(state.artifact?.events ?? []);
});

$("#function-inspector").addEventListener("change", event => {
  const events = state.artifact?.events ?? [];
  if (event.target.id === "function-call-value") state.functionCallValue = event.target.value;
  if (event.target.dataset.argumentIndex !== undefined) state.functionValues[Number(event.target.dataset.argumentIndex)] = event.target.value;
  const deployment = currentDeployment(events);
  const contract = selectedContract(deployment);
  renderFunctionInspector(contract, selectedFunction(contract), currentTrace(events));
});

$("#deployment-source").addEventListener("change", event => {
  state.deploymentSource = event.target.value;
  state.selectedContractId = null;
  state.selectedFunctionSelector = null;
  state.functionValues = {};
  renderDeployment(state.artifact?.events ?? []);
});

for (const [selector, key, renderer] of [
  ["#timeline-search", "timelineSearch", renderTimeline],
  ["#network-search", "networkSearch", renderNetwork],
  ["#contract-search", "contractSearch", renderDeployment],
  ["#function-search", "functionSearch", renderDeployment]
]) {
  $(selector).addEventListener("input", event => {
    state[key] = event.target.value;
    if (state.artifact || renderer === renderDeployment) renderer(state.artifact?.events ?? []);
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

async function loadSepoliaDeployment() {
  try {
    const response = await fetch("/api/deployments/sepolia", { cache: "no-store" });
    state.sepoliaDeployment = await response.json();
  } catch {
    state.sepoliaDeployment = { status: "unavailable" };
  }
  renderDeployment(state.artifact?.events ?? []);
}

loadSepoliaDeployment();
poll();
