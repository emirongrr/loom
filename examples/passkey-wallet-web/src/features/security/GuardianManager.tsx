import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "@loom/core";
import { useNetwork } from "../../config/NetworkContext";
import { useNotifications } from "../../notifications/NotificationsContext";
import { submitAccountCalls } from "../wallet/accountClient";
import { transactionUrl } from "../../config/network";
import { createAccountGuardianClient, readVerifierCodeHash } from "./guardianClient";
import {
  assertAddable, buildGuardianDescriptor, clampThreshold, describeGuardian, formatDelay,
  MIN_DELAY_SECONDS, planGuardianChange, suggestedThreshold, withFreshSalts, type RosterEntry
} from "./guardianPlan";
import { createBrowserGuardianRoster } from "../../storage/guardianRoster";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";

type Stage = "list" | "review" | "scheduled";

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

  useEffect(() => {
    let active = true;
    void roster.read(account.id).then(stored => {
      if (!active) return;
      setCommitted(stored.entries);
      setDraft(stored.entries);
      setThreshold(clampThreshold(onChain?.threshold ?? suggestedThreshold(stored.entries.length), Math.max(1, stored.entries.length)));
    });
    return () => { active = false; };
  }, [roster, account.id, onChain?.threshold]);

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
      await roster.write(account.id, salted, Date.now());
      notifications.update(toast, {
        status: "success", title: "Guardian change scheduled",
        detail: `Executable after ${formatDelay(MIN_DELAY_SECONDS)}. You can cancel until then.`,
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      setStage("scheduled");
      onChanged();
    } catch (issue) {
      const message = issue instanceof Error ? issue.message : "The change could not be scheduled.";
      notifications.update(toast, { status: "error", title: "Scheduling failed", detail: message });
      setError(message);
    } finally { setBusy(false); }
  };

  const dirty = plan !== null && (plan.added.length > 0 || plan.removed.length > 0 || threshold !== (onChain?.threshold ?? 0));

  return <section className="section-card">
    <div className="section-heading">
      <div><p className="eyebrow">Recovery quorum</p><h2>Guardians</h2></div>
      <span className="pill">{committed.length > 0 ? `${onChain?.threshold ?? threshold}-of-${committed.length}` : "Not set up"}</span>
    </div>

    <ol className="stepper" aria-label="Guardian setup steps">
      <li className={stage === "list" ? "active" : "done"}><span>1</span>Choose guardians</li>
      <li className={stage === "review" ? "active" : stage === "scheduled" ? "done" : ""}><span>2</span>Review</li>
      <li className={stage === "scheduled" ? "active" : ""}><span>3</span>Wait {formatDelay(MIN_DELAY_SECONDS)}</li>
    </ol>

    {stage === "list" && <>
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

    {stage === "review" && plan && <>
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

    {stage === "scheduled" && <>
      <p className="callout success">The change is scheduled. It becomes executable after {formatDelay(MIN_DELAY_SECONDS)}, and you can cancel it before then. Recovery keeps working under the current set until it executes.</p>
      <p className="form-note">Deliver each guardian their invitation from the guardian workspace once the change executes.</p>
      <button className="secondary" onClick={() => { setStage("list"); onChanged(); }}>Back to guardians</button>
    </>}
  </section>;
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
