import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "@loom/core";
import { useNetwork } from "../../config/NetworkContext";
import { useNotifications } from "../../notifications/NotificationsContext";
import { submitAccountCalls } from "../wallet/accountClient";
import { transactionUrl } from "../../config/network";
import { createAccountGuardianClient, readVerifierCodeHash } from "./guardianClient";
import {
  assertAddable, buildGuardianDescriptor, clampThreshold, describeGuardian, formatCountdown, formatDelay,
  formatReadyAt, MIN_DELAY_SECONDS, planGuardianChange, suggestedThreshold, withFreshSalts, type RosterEntry
} from "./guardianPlan";
import { cancelPendingGuardianChange, executePendingGuardianChange, readPendingGuardianChange, type PendingChangeStatus } from "./pendingChange";
import { createBrowserGuardianRoster } from "../../storage/guardianRoster";
import type { RosterPending } from "../../storage/guardianRosterRecord";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";

type Stage = "list" | "review";

export function GuardianManager({ account, deployment, onChain, onChanged }: {
  account: AccountHandle;
  deployment: WalletDeployment | null;
  onChain: { root: Hex; threshold: number } | null;
  onChanged(): void;
}) {
  const { config } = useNetwork();
  const notifications = useNotifications();
  const roster = useMemo(() => createBrowserGuardianRoster(), []);

  const [committed, setCommitted] = useState<readonly RosterEntry[]>([]);
  const [draft, setDraft] = useState<readonly RosterEntry[]>([]);
  const [threshold, setThreshold] = useState(1);
  const [stage, setStage] = useState<Stage>("list");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<RosterPending | null>(null);
  const [status, setStatus] = useState<PendingChangeStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [reloads, setReloads] = useState(0);
  // Advances the countdown between chain reads, from the chain's own timestamp.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    void roster.read(account.id).then(stored => {
      if (!active) return;
      setCommitted(stored.entries);
      setDraft(stored.entries);
      setPending(stored.pending);
      setThreshold(clampThreshold(onChain?.threshold ?? suggestedThreshold(stored.entries.length), Math.max(1, stored.entries.length)));
    });
    return () => { active = false; };
  }, [roster, account.id, onChain?.threshold, reloads]);

  // Ask the account when the scheduled change becomes executable.
  useEffect(() => {
    if (!pending || !deployment?.recoveryModule) { setStatus(null); return; }
    let active = true;
    setStatusError("");
    readPendingGuardianChange({ config, account, deployment, pending })
      .then(result => { if (active) setStatus(result); })
      .catch(issue => { if (active) setStatusError(issue instanceof Error ? issue.message : "The scheduled change could not be read."); });
    return () => { active = false; };
  }, [config, account, deployment, pending, reloads]);

  useEffect(() => {
    if (!status?.found || status.ready) return;
    const timer = setInterval(() => setTick(value => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [status?.found, status?.ready]);

  const verifiers = deployment?.guardianVerifiers;
  const plan = useMemo(() => {
    if (draft.length === 0) return null;
    try { return planGuardianChange({ current: committed, next: draft, threshold, ...(onChain ? { onChain } : {}) }); }
    catch { return null; }
  }, [committed, draft, threshold, onChain]);

  const addGuardian = async (kind: "ecdsa" | "erc1271", label: string, value: string) => {
    setError("");
    if (!verifiers) { setError("This deployment does not publish guardian verifiers."); return; }
    const verifier = kind === "ecdsa" ? verifiers.ecdsa : verifiers.erc1271;
    if (!verifier) { setError(`This deployment has no ${kind.toUpperCase()} guardian verifier.`); return; }
    setBusy(true);
    try {
      const verifierCodeHash = await readVerifierCodeHash(config, verifier);
      const descriptor = buildGuardianDescriptor({ kind, value, verifier, verifierCodeHash });
      assertAddable(draft, descriptor);
      const entry: RosterEntry = { id: crypto.randomUUID(), label: label.trim() || describeGuardian(descriptor).slice(0, 10), descriptor };
      const next = [...draft, entry];
      setDraft(next);
      setThreshold(current => clampThreshold(current, next.length));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "The guardian could not be added.");
    } finally { setBusy(false); }
  };

  const removeGuardian = (id: string) => {
    const next = draft.filter(entry => entry.id !== id);
    setDraft(next);
    setThreshold(current => clampThreshold(current, next.length));
    setError("");
  };

  const schedule = async () => {
    if (!deployment?.recoveryModule || !plan) { setError("This deployment has no recovery module."); return; }
    setBusy(true); setError("");
    const toast = notifications.notify({ status: "pending", title: "Scheduling guardian change", detail: `Takes effect after ${formatDelay(MIN_DELAY_SECONDS)}` });
    try {
      // Salts rotate now and are persisted with the pending plan, so the exact
      // scheduled operation can still be executed after a reload.
      const salted = withFreshSalts(draft);
      const finalPlan = planGuardianChange({ current: committed, next: salted, threshold });
      const client = createAccountGuardianClient({ config, chainId: account.chainId, account: account.account, recoveryManager: deployment.recoveryModule });
      const prepared = await client.prepareGuardianConfiguration({ set: finalPlan.set, delaySeconds: MIN_DELAY_SECONDS });

      const result = await submitAccountCalls({
        config, account, deployment,
        calls: [{ target: prepared.scheduleCall.target as Address, value: 0n, data: prepared.scheduleCall.data as Hex }]
      });
      // Stored as pending, not committed: until the delay elapses and the change
      // executes, the guardian set that can actually recover this account is
      // still the old one.
      await roster.write(account.id, {
        entries: committed,
        version: Date.now(),
        pending: { entries: salted, threshold, scheduledAt: Date.now() }
      });
      notifications.update(toast, {
        status: "success", title: "Guardian change scheduled",
        detail: `Executable after ${formatDelay(MIN_DELAY_SECONDS)}. You can cancel until then.`,
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      setStage("list");
      setReloads(count => count + 1);
      onChanged();
    } catch (issue) {
      const message = issue instanceof Error ? issue.message : "The change could not be scheduled.";
      notifications.update(toast, { status: "error", title: "Scheduling failed", detail: message });
      setError(message);
    } finally { setBusy(false); }
  };

  const execute = async () => {
    if (!deployment || !status?.prepared || !pending) return;
    setBusy(true); setError("");
    const toast = notifications.notify({ status: "pending", title: "Applying guardian change" });
    try {
      const result = await executePendingGuardianChange({ config, account, deployment, prepared: status.prepared });
      // Only now is the new set the one that can recover the account.
      await roster.write(account.id, { entries: pending.entries, version: Date.now(), pending: null });
      notifications.update(toast, {
        status: "success", title: "Guardians updated",
        detail: `${pending.threshold} of ${pending.entries.length} approvals can now recover this account.`,
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      setReloads(count => count + 1);
      onChanged();
    } catch (issue) {
      const message = issue instanceof Error ? issue.message : "The change could not be applied.";
      notifications.update(toast, { status: "error", title: "Could not apply", detail: message });
      setError(message);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!deployment || !status?.prepared) return;
    setBusy(true); setError("");
    const toast = notifications.notify({ status: "pending", title: "Cancelling guardian change" });
    try {
      const result = await cancelPendingGuardianChange({ config, account, deployment, prepared: status.prepared });
      await roster.write(account.id, { entries: committed, version: Date.now(), pending: null });
      notifications.update(toast, {
        status: "success", title: "Guardian change cancelled", detail: "Your existing guardians are unchanged.",
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      setReloads(count => count + 1);
      onChanged();
    } catch (issue) {
      const message = issue instanceof Error ? issue.message : "The change could not be cancelled.";
      notifications.update(toast, { status: "error", title: "Could not cancel", detail: message });
      setError(message);
    } finally { setBusy(false); }
  };

  /** Discard a local pending record the chain no longer holds. */
  const forgetPending = async () => {
    await roster.write(account.id, { entries: committed, version: Date.now(), pending: null });
    setReloads(count => count + 1);
  };

  const dirty = plan !== null && (plan.added.length > 0 || plan.removed.length > 0 || threshold !== (onChain?.threshold ?? 0));

  return <section className="section-card">
    <div className="section-heading">
      <div><p className="eyebrow">Recovery quorum</p><h2>Guardians</h2></div>
      <span className="pill">{committed.length > 0 ? `${onChain?.threshold ?? threshold}-of-${committed.length}` : "Not set up"}</span>
    </div>

    <ol className="stepper" aria-label="Guardian setup steps">
      <li className={pending ? "done" : stage === "list" ? "active" : "done"}><span>1</span>Choose guardians</li>
      <li className={pending ? "done" : stage === "review" ? "active" : ""}><span>2</span>Review</li>
      <li className={pending ? "active" : ""}><span>3</span>Wait {formatDelay(MIN_DELAY_SECONDS)}</li>
    </ol>

    {pending && <PendingChange
      pending={pending}
      status={status}
      statusError={statusError}
      busy={busy}
      onExecute={() => void execute()}
      onCancel={() => void cancel()}
      onForget={() => void forgetPending()}
      onRefresh={() => setReloads(count => count + 1)}
      tick={tick}
    />}

    {!pending && stage === "list" && <>
      {draft.length === 0
        ? <p className="form-note">No guardians yet. Add people or wallets that can help you recover this account — they never gain spending power.</p>
        : <div className="guardian-list">{draft.map(entry => <div className="guardian-row" key={entry.id}>
            <span className="round-icon" aria-hidden="true">{entry.descriptor.kind === "erc1271" ? "▣" : "◆"}</span>
            <div><strong>{entry.label}</strong><p className="breakable">{describeGuardian(entry.descriptor)}</p></div>
            <button className="text-button" onClick={() => removeGuardian(entry.id)}>Remove</button>
          </div>)}</div>}

      <AddGuardianForm busy={busy} onAdd={addGuardian} hasErc1271={Boolean(verifiers?.erc1271)} />

      {draft.length > 0 && <div className="threshold-row">
        <label className="field"><span>Approvals needed to recover</span>
          <select value={threshold} onChange={event => setThreshold(Number(event.target.value))}>
            {Array.from({ length: draft.length }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} of {draft.length}</option>)}
          </select>
          <small className="form-note">A higher threshold resists a compromised guardian; a lower one survives an unreachable guardian.</small>
        </label>
      </div>}

      {error && <p className="callout warning">{error}</p>}
      <div className="guardian-actions">
        <button className="primary" disabled={!dirty || busy || !plan} onClick={() => { setError(""); setStage("review"); }}>Review changes</button>
        {dirty && <button className="secondary" onClick={() => { setDraft(committed); setError(""); }}>Discard</button>}
      </div>
    </>}

    {!pending && stage === "review" && plan && <>
      <div className="review-summary">
        {plan.added.map(entry => <div key={entry.id}><span className="amount-in">Add</span><strong className="breakable">{entry.label} · {describeGuardian(entry.descriptor)}</strong></div>)}
        {plan.removed.map(entry => <div key={entry.id}><span className="amount-failed">Remove</span><strong className="breakable">{entry.label} · {describeGuardian(entry.descriptor)}</strong></div>)}
        <div><span>Threshold</span><strong>{plan.threshold} of {plan.set.guardians.length}</strong></div>
        <div><span>Takes effect</span><strong>After {formatDelay(MIN_DELAY_SECONDS)}</strong></div>
      </div>
      <p className="callout">Only the guardian root and the threshold are published on chain. Guardian identities stay on this device, and a guardian never gains spending power.</p>
      {error && <p className="callout warning">{error}</p>}
      <div className="guardian-actions">
        <button className="secondary" disabled={busy} onClick={() => setStage("list")}>Back</button>
        <button className="primary" disabled={busy} onClick={() => void schedule()}>{busy ? "Confirm on your device…" : "Schedule with passkey"}</button>
      </div>
    </>}

  </section>;
}

function PendingChange({ pending, status, statusError, busy, onExecute, onCancel, onForget, onRefresh, tick }: {
  pending: RosterPending;
  status: PendingChangeStatus | null;
  statusError: string;
  busy: boolean;
  onExecute(): void;
  onCancel(): void;
  onForget(): void;
  onRefresh(): void;
  tick: number;
}) {
  // The countdown advances from the chain's timestamp, not the device clock, so
  // a wrong local clock cannot make a change look ready before it is.
  const estimatedNow = status ? status.chainTimestamp + BigInt(tick * 30) : 0n;
  const ready = status?.ready === true || (status !== null && status.readyAt > 0n && estimatedNow >= status.readyAt);

  return <div className={`pending-change ${ready ? "ready" : ""}`}>
    <div className="pending-head">
      <div>
        <p className="eyebrow">Scheduled change</p>
        <h3>{pending.threshold} of {pending.entries.length} guardians</h3>
      </div>
      <span className={`pill ${ready ? "included" : "pending"}`}>{status === null ? "Checking" : status.found ? (ready ? "Ready" : "Waiting") : "Not found"}</span>
    </div>

    {status === null && !statusError && <p className="form-note">Reading the scheduled change from the account…</p>}

    {statusError && <p className="callout warning">The scheduled change could not be read: {statusError}</p>}

    {status?.found && <>
      <div className="countdown">
        <strong>{ready ? "Ready to apply" : formatCountdown(status.readyAt, estimatedNow)}</strong>
        <span>Takes effect {formatReadyAt(status.readyAt)}</span>
      </div>
      {!ready && <p className="form-note">Your current guardians stay in force until this is applied. You can cancel it at any point before then.</p>}
      {ready && <p className="callout success">The delay has elapsed. Apply the change to make these guardians the ones that can recover this account.</p>}
      <div className="guardian-actions">
        {ready && <button className="primary" disabled={busy} onClick={onExecute}>{busy ? "Confirm on your device…" : "Apply change"}</button>}
        <button className="danger-button" disabled={busy} onClick={onCancel}>Cancel change</button>
        <button className="text-button" disabled={busy} onClick={onRefresh}>Refresh</button>
      </div>
    </>}

    {status !== null && !status.found && <>
      <p className="callout warning">
        The account holds no such scheduled change. It was either already applied, cancelled, or invalidated by a later
        configuration change — a new configuration version retires any operation scheduled against the previous one.
      </p>
      <div className="guardian-actions">
        <button className="secondary" disabled={busy} onClick={onForget}>Discard this record</button>
        <button className="text-button" disabled={busy} onClick={onRefresh}>Check again</button>
      </div>
    </>}
  </div>;
}

function AddGuardianForm({ busy, onAdd, hasErc1271 }: {
  busy: boolean;
  onAdd(kind: "ecdsa" | "erc1271", label: string, value: string): void;
  hasErc1271: boolean;
}) {
  const [kind, setKind] = useState<"ecdsa" | "erc1271">("ecdsa");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const submit = () => { onAdd(kind, label, value); setLabel(""); setValue(""); };
  return <details className="add-guardian">
    <summary>Add a guardian</summary>
    <div className="add-guardian-body">
      <label className="field"><span>Guardian type</span>
        <select value={kind} onChange={event => setKind(event.target.value as "ecdsa" | "erc1271")}>
          <option value="ecdsa">A person's wallet address</option>
          {hasErc1271 && <option value="erc1271">A smart contract account</option>}
        </select>
      </label>
      <label className="field"><span>Name (only you see this)</span>
        <input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="Alex" />
      </label>
      <label className="field"><span>Address</span>
        <input value={value} onChange={event => setValue(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
      </label>
      <button className="secondary" disabled={busy || value.trim() === ""} onClick={submit}>{busy ? "Checking verifier…" : "Add to list"}</button>
    </div>
  </details>;
}
