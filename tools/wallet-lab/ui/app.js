const $ = selector => document.querySelector(selector);
const format = value => typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "—");
const short = value => value && value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value ?? "—";
const escapeHtml = value => String(value ?? "—").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function statusClass(status) {
  if (["success", "finalized", "confirmed", "included"].includes(status)) return "success";
  if (["error", "reverted", "dropped", "reorganized"].includes(status)) return "error";
  return "waiting";
}

function renderEnvironment(environment) {
  const root = $("#environment");
  if (!environment) return;
  root.classList.remove("empty");
  const core = [
    ["Chain", environment.chainId],
    ["Git commit", short(environment.gitCommit)],
    ["Working tree", environment.dirty ? "Dirty" : "Clean"],
    ["Snapshot", environment.snapshotId ?? "Pending"]
  ];
  root.innerHTML = core.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("") +
    environment.components.map(component => `<article><span>${escapeHtml(component.name)}</span><strong>${escapeHtml(component.version)}</strong><small class="${statusClass(component.status === "healthy" ? "success" : "error")}">${escapeHtml(component.status)}</small></article>`).join("");
}

function renderTimeline(events) {
  $("#timeline-count").textContent = `${events.length} stage${events.length === 1 ? "" : "s"}`;
  $("#timeline").innerHTML = events.map(event => `
    <li class="event ${statusClass(event.status)}">
      <div class="event-marker">${escapeHtml(event.monotonicSequence)}</div>
      <div class="event-body">
        <div class="event-head"><strong>${escapeHtml(event.phase)}</strong><span>${escapeHtml(event.component)}</span><span class="pill">${escapeHtml(event.status)}</span><span>${escapeHtml(event.durationMs === undefined ? "live" : `${event.durationMs} ms`)}</span></div>
        <p>${escapeHtml(event.explanation)}</p>
        <div class="identifiers">${event.userOpHash ? `<code>UserOp ${escapeHtml(short(event.userOpHash))}</code>` : ""}${event.transactionHash ? `<code>Tx ${escapeHtml(short(event.transactionHash))}</code>` : ""}${event.blockNumber !== undefined ? `<code>Block ${escapeHtml(event.blockNumber)}</code>` : ""}</div>
        <details><summary>Raw stage data</summary><pre>${escapeHtml(format(event.payload))}</pre>${event.reproduction ? `<code>${escapeHtml(event.reproduction)}</code>` : ""}</details>
      </div>
    </li>`).join("");
}

function renderState(values) {
  const root = $("#state-diff");
  if (!values.length) return;
  root.classList.remove("empty");
  root.innerHTML = values.map(value => `<article><span>${escapeHtml(value.name)}</span><div><code>${escapeHtml(format(value.before))}</code><b>→</b><code>${escapeHtml(format(value.after))}</code></div><p>${escapeHtml(value.explanation)}</p></article>`).join("");
}

function renderInvariants(values) {
  const root = $("#invariants");
  root.classList.remove("empty");
  root.innerHTML = values.map(value => `<article class="${statusClass(value.status === "pass" ? "success" : value.status === "fail" ? "error" : "waiting")}"><strong>${escapeHtml(value.id)}</strong><span>${escapeHtml(value.status)}</span><p>${escapeHtml(value.explanation)}</p></article>`).join("");
}

function render(artifact) {
  $("#run-summary").textContent = `${artifact.scenarioId} · ${artifact.runId}`;
  const status = $("#run-status");
  status.textContent = artifact.status;
  status.className = `status ${statusClass(artifact.status)}`;
  $("#updated-at").textContent = artifact.finishedAt ? `Finished ${new Date(artifact.finishedAt).toLocaleTimeString()}` : "Live";
  renderEnvironment(artifact.environment);
  renderTimeline(artifact.events);
  renderState(artifact.stateDiff);
  renderInvariants(artifact.invariants);
  $("#replay").textContent = `${artifact.replay.command}\nseed=${artifact.replay.seed}\nschema=${artifact.schema}@${artifact.version}\nredaction=${artifact.redaction.level}`;
  if (artifact.firstFailingBoundary) {
    $("#failure-panel").hidden = false;
    $("#failure").textContent = `${artifact.firstFailingBoundary}: inspect the first error stage in the timeline.`;
  }
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
