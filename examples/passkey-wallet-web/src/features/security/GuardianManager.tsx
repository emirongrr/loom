import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "@loom/core";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { useNotifications } from "../../notifications/NotificationsContext";
import { submitAccountCalls } from "../wallet/accountClient";
import { transactionUrl } from "../../config/network";
import { createAccountGuardianClient, readVerifierCodeHash } from "./guardianClient";
import {
  assertAddable, buildGuardianDescriptor, clampThreshold, describeGuardian, formatCountdown, formatDelay,
  formatReadyAt, MIN_DELAY_SECONDS, planGuardianChange, suggestedThreshold, withFreshSalts, type GuardianChangePlan, type RosterEntry
} from "./guardianPlan";
import { cancelPendingGuardianChange, executePendingGuardianChange, readPendingGuardianChange, type PendingChangeStatus } from "./pendingChange";
import {
  createRosterBackup, deriveGuardianStatus, parseRosterBackup, verifyRosterBackup,
  type GuardianStatus, type OnChainGuardians
} from "./guardianStatus";
import { readScheduledOperations, type ScheduledOperation } from "./scheduledOperations";
import { AddGuardianForm } from "./AddGuardianForm";
import { createLoomGuardianChainReader, detectGuardianAddress, resolveLoomP256Guardian } from "./loomGuardian";
import { PendingChangeCard } from "./PendingChangeCard";
import { RestoreRoster } from "./RestoreRoster";
import { GuardianInvitationCard, type GuardianInvitationView } from "./GuardianInvitationCard";
import { createActiveGuardianInvitation } from "./guardianInvitation";
import { createBrowserGuardianRoster } from "../../storage/guardianRoster";
import type { RosterPending } from "../../storage/guardianRosterRecord";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";
import { useGuardianManagerController } from "./useGuardianManagerController";
import { safeUserMessage } from "../../domain/errors/appError";

export function GuardianManager({ account, deployment, onChain, onChanged }: {
  account: AccountHandle;
  deployment: WalletDeployment | null;
  onChain: OnChainGuardians | null;
  onChanged(): void;
}) {
  const { config } = useNetwork();
  const services = useAppServices();
  const notifications = useNotifications();
  const roster = useMemo(() => createBrowserGuardianRoster(), []);

  const [committed, setCommitted] = useState<readonly RosterEntry[]>([]);
  const [setVersion, setSetVersion] = useState(0);
  const [draft, setDraft] = useState<readonly RosterEntry[]>([]);
  const [threshold, setThreshold] = useState(1);
  const { stage, setStage, busy, setBusy, error, setError } = useGuardianManagerController();
  const [pending, setPending] = useState<RosterPending | null>(null);
  const [status, setStatus] = useState<PendingChangeStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [reloads, setReloads] = useState(0);
  // Advances the countdown between chain reads, from the chain's own timestamp.
  const [tick, setTick] = useState(0);
  const [invitation, setInvitation] = useState<GuardianInvitationView | null>(null);

  useEffect(() => {
    let active = true;
    void roster.read(account.id).then(stored => {
      if (!active) return;
      setCommitted(stored.entries);
      setSetVersion(stored.version);
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

  // A change scheduled from another device — or before this device kept a record
  // — exists only on chain. Discover it there so it is never silently invisible.
  const [onChainOperations, setOnChainOperations] = useState<readonly ScheduledOperation[]>([]);
  const [chainNow, setChainNow] = useState(0n);

  useEffect(() => {
    let active = true;
    readScheduledOperations({ config, account: account.account })
      .then(result => {
        if (!active) return;
        setOnChainOperations(result.operations);
        setChainNow(result.chainTimestamp);
      })
      .catch(() => { if (active) setOnChainOperations([]); });
    return () => { active = false; };
  }, [config, account.account, reloads]);

  // Anything the local record already explains is not reported a second time.
  const unexplained = onChainOperations.filter(operation => operation.operationId !== status?.prepared.operationId);

  // The account's own state decides whether it is protected, never the local
  // list: a device that lost its roster must still be told the truth.
  const protection: GuardianStatus = useMemo(
    () => deriveGuardianStatus({ onChain, entries: committed }),
    [onChain, committed]
  );

  const exportRoster = () => {
    const backup = createRosterBackup({
      account: account.account,
      chainId: account.chainId,
      threshold: onChain?.threshold ?? committed.length,
      entries: committed
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `loom-guardians-${account.account.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notifications.notify({
      status: "success",
      title: "Guardian list exported",
      detail: "Keep it private: it names your guardians. Without it this device cannot edit the set."
    });
  };

  /** Restore only a private backup that reconstructs the live root. */
  const restoreRoster = async (text: string) => {
    setError("");
    if (!onChain) { setError("The account's guardian state has not loaded yet."); return; }
    setBusy(true);
    try {
      const backup = parseRosterBackup(JSON.parse(text));
      const verdict = verifyRosterBackup({ backup, account: account.account, chainId: account.chainId, onChain });
      if (!verdict.ok) throw new Error(verdict.reason);
      await roster.write(account.id, { entries: backup.entries, version: Date.now(), pending: null });
      notifications.notify({
        status: "success",
        title: "Guardian list restored",
        detail: "It rebuilds this account's on-chain guardian root, so it is the real set."
      });
      setReloads(count => count + 1);
      onChanged();
    } catch (issue) {
      setError(safeUserMessage(issue, "The guardian backup could not be verified.", "storage"));
    } finally { setBusy(false); }
  };

  const verifiers = deployment?.guardianVerifiers;
  const planning = useMemo<{ plan: GuardianChangePlan | null; error: string }>(() => {
    if (draft.length === 0) return { plan: null, error: "" };
    try { return { plan: planGuardianChange({ current: committed, next: draft, threshold, ...(onChain ? { onChain } : {}) }), error: "" }; }
    catch (issue) { return { plan: null, error: issue instanceof Error ? issue.message : "Guardian changes could not be reviewed." }; }
  }, [committed, draft, threshold, onChain]);
  const plan = planning.plan;

  const addGuardian = async (label: string, value: string) => {
    setError("");
    if (!verifiers) { setError("This deployment does not publish guardian verifiers."); return; }
    setBusy(true);
    try {
      const chainReader = createLoomGuardianChainReader(config, deployment!);
      const detected = await detectGuardianAddress(value, chainReader);
      const verifier = detected.kind === "loom" ? verifiers.p256 : detected.kind === "ecdsa" ? verifiers.ecdsa : verifiers.erc1271;
      if (!verifier) throw new Error("This deployment cannot verify this guardian address type.");
      const verifierCodeHash = await readVerifierCodeHash(config, verifier);
      const descriptor = detected.kind === "loom"
        ? await resolveLoomP256Guardian({ value, deployment: deployment!, verifierCodeHash, reader: chainReader })
        : buildGuardianDescriptor({ kind: detected.kind, value: detected.address, verifier, verifierCodeHash });
      assertAddable(draft, descriptor);
      const entry: RosterEntry = { id: crypto.randomUUID(), label: label.trim() || describeGuardian(descriptor).slice(0, 10), descriptor };
      const next = [...draft, entry];
      setDraft(next);
      setThreshold(current => clampThreshold(current, next.length));
      if (detected.warning) setError(detected.warning);
    } catch (issue) {
      setError(safeUserMessage(issue, "The guardian could not be verified and added.", "validation"));
    } finally { setBusy(false); }
  };

  const removeGuardian = (id: string) => {
    const next = draft.filter(entry => entry.id !== id);
    setDraft(next);
    setThreshold(current => clampThreshold(current, next.length));
    setError("");
  };

  const inviteGuardian = async (entry: RosterEntry) => {
    setError("");
    if (!onChain || protection.kind !== "in-sync") {
      setError("Invites are available only when this device's roster matches the active on-chain guardian set.");
      return;
    }
    setBusy(true);
    try {
      const expiresAt = Math.floor(services.now() / 1_000) + 7 * 86_400;
      const invite = createActiveGuardianInvitation({
        entries: committed,
        guardianId: entry.id,
        setVersion,
        onChain,
        chainId: account.chainId,
        account: account.account,
        capabilityId: randomBytes32(),
        expiresAt
      });
      const delivered = await services.invitationLinks.deliver(invite, { expiresAt });
      setInvitation({ guardianId: entry.id, guardianLabel: entry.label, link: delivered.value, expiresAt });
      notifications.notify({
        status: "success",
        title: "Guardian invite ready",
        detail: `Send it privately to ${entry.label}; they must accept it on their device.`
      });
    } catch (issue) {
      setError(safeUserMessage(issue, "The guardian invite could not be created.", "preparation"));
    } finally { setBusy(false); }
  };

  const copyInvitation = async () => {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.link);
      notifications.notify({ status: "success", title: "Invite link copied", detail: "Send it to the intended guardian over a private channel." });
    } catch {
      setError("The browser could not copy the invite. Select the link and copy it manually.");
    }
  };

  const schedule = async () => {
    if (!deployment?.recoveryModule || !plan) { setError("This deployment has no recovery module."); return; }
    setBusy(true); setError("");
    const toast = notifications.notify({ status: "pending", title: "Scheduling guardian change", detail: `Takes effect after ${formatDelay(MIN_DELAY_SECONDS)}` });
    try {
      await services.runtime.verify(config, deployment);
      // Rotate every guardian to a fresh independent salt for the committed
      // epoch. The reviewed draft used temporary salts only to validate shape;
      // these are the values persisted and scheduled on chain.
      const salted = withFreshSalts(draft);
      const finalPlan = planGuardianChange({ current: committed, next: salted, threshold });
      const client = createAccountGuardianClient({ config, chainId: account.chainId, account: account.account, recoveryManager: deployment.recoveryModule });
      const prepared = await client.prepareGuardianConfiguration({ set: finalPlan.set, delaySeconds: MIN_DELAY_SECONDS });

      const result = await submitAccountCalls({
        config, account, deployment,
        calls: [{ target: prepared.scheduleCall.target as Address, value: 0n, data: prepared.scheduleCall.data as Hex }],
        pendingOperations: services.pendingOperations
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
      const message = safeUserMessage(issue, "The guardian change could not be scheduled.", "submission");
      notifications.update(toast, { status: "error", title: "Scheduling failed", detail: message });
      setError(message);
    } finally { setBusy(false); }
  };

  const execute = async () => {
    if (!deployment || !status?.prepared || !pending) return;
    setBusy(true); setError("");
    const toast = notifications.notify({ status: "pending", title: "Applying guardian change" });
    try {
      await services.runtime.verify(config, deployment);
      const result = await executePendingGuardianChange({ config, account, deployment, prepared: status.prepared, pendingOperations: services.pendingOperations });
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
      const message = safeUserMessage(issue, "The guardian change could not be applied.", "submission");
      notifications.update(toast, { status: "error", title: "Could not apply", detail: message });
      setError(message);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!deployment || !status?.prepared) return;
    setBusy(true); setError("");
    const toast = notifications.notify({ status: "pending", title: "Cancelling guardian change" });
    try {
      await services.runtime.verify(config, deployment);
      const result = await cancelPendingGuardianChange({ config, account, deployment, prepared: status.prepared, pendingOperations: services.pendingOperations });
      await roster.write(account.id, { entries: committed, version: Date.now(), pending: null });
      notifications.update(toast, {
        status: "success", title: "Guardian change cancelled", detail: "Your existing guardians are unchanged.",
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      setReloads(count => count + 1);
      onChanged();
    } catch (issue) {
      const message = safeUserMessage(issue, "The guardian change could not be cancelled.", "submission");
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
      <span className={`pill ${protection.kind === "unprotected" ? "" : "included"}`}>
        {protection.kind === "unprotected" ? "Not set up"
          : protection.kind === "in-sync" ? `${protection.threshold}-of-${committed.length}`
          : `${protection.threshold} approvals required`}
      </span>
    </div>

    {onChain && !onChain.recoveryConfigured && protection.kind !== "unprotected" && <p className="callout warning">
      This account publishes a guardian root, but its recovery module is not installed, so guardians cannot currently
      propose a recovery. Reinstall the recovery module before relying on this quorum.
    </p>}

    <ol className="stepper" aria-label="Guardian setup steps">
      <li className={pending ? "done" : stage === "list" ? "active" : "done"}><span>1</span>Choose guardians</li>
      <li className={pending ? "done" : stage === "review" ? "active" : ""}><span>2</span>Review</li>
      <li className={pending ? "active" : ""}><span>3</span>Wait {formatDelay(MIN_DELAY_SECONDS)}</li>
    </ol>

    {pending && <PendingChangeCard
      config={config}
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

    {unexplained.length > 0 && <div className="pending-change">
      <div className="pending-head">
        <div>
          <p className="eyebrow">Scheduled on chain</p>
          <h3>{unexplained.length === 1 ? "A change is waiting" : `${unexplained.length} changes are waiting`}</h3>
        </div>
        <span className={`pill ${unexplained.some(operation => operation.ready) ? "included" : "pending"}`}>
          {unexplained.some(operation => operation.ready) ? "Ready" : "Waiting"}
        </span>
      </div>
      {unexplained.map(operation => <div className="countdown" key={operation.operationId}>
        <strong>{operation.ready ? "Ready to apply" : formatCountdown(operation.readyAt, chainNow)}</strong>
        <span>Becomes executable {formatReadyAt(operation.readyAt)}</span>
      </div>)}
      <p className="form-note">
        The account holds this scheduled operation, but this device does not know what it changes: an operation is stored
        under a hash of its contents, so the contents cannot be read back from the chain. Open this account on the device
        that scheduled it to apply or cancel it, or schedule the change again from here once it has lapsed.
      </p>
    </div>}

    {!pending && (protection.kind === "list-missing" || protection.kind === "list-mismatch") && <RestoreRoster
      status={protection}
      busy={busy}
      error={error}
      onRestore={text => void restoreRoster(text)}
      onDismissError={() => setError("")}
    />}

    {!pending && protection.kind !== "list-missing" && protection.kind !== "list-mismatch" && stage === "list" && <>
      {draft.length === 0
        ? <p className="form-note">No guardians yet. Add people or wallets that can help you recover this account — they never gain spending power.</p>
        : <div className="guardian-list">{draft.map(entry => <div className="guardian-row" key={entry.id}>
            <span className="round-icon" aria-hidden="true">{entry.descriptor.kind === "erc1271" ? "▣" : "◆"}</span>
            <div><strong>{entry.label}</strong><p className="breakable">{describeGuardian(entry.descriptor)}</p></div>
            <div className="guardian-row-actions">
              {protection.kind === "in-sync" && committed.some(item => item.id === entry.id) &&
                <button className="text-button" disabled={busy} onClick={() => void inviteGuardian(entry)}>Invite</button>}
              <button className="text-button" onClick={() => removeGuardian(entry.id)}>Remove</button>
            </div>
          </div>)}</div>}

      {invitation && <GuardianInvitationCard
        invitation={invitation}
        onCopy={() => void copyInvitation()}
        onClose={() => setInvitation(null)}
      />}

      {protection.kind === "in-sync" && <p className="form-note">
        This list is held only on this device and matches the account's on-chain guardian root.{" "}
        <button className="text-button" onClick={exportRoster}>Export a backup</button> — without it, another device cannot edit the set.
      </p>}

      <AddGuardianForm busy={busy} onAdd={addGuardian} />

      {draft.length > 0 && <div className="threshold-row">
        <label className="field"><span>Approvals needed to recover</span>
          <select value={threshold} onChange={event => setThreshold(Number(event.target.value))}>
            {Array.from({ length: draft.length }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} of {draft.length}</option>)}
          </select>
          <small className="form-note">A higher threshold resists a compromised guardian; a lower one survives an unreachable guardian.</small>
        </label>
      </div>}

      {error && <p className="callout warning">{error}</p>}
      {!error && planning.error && <p className="callout warning">{planning.error}</p>}
      <div className="guardian-actions">
        <button className="primary" disabled={!dirty || busy || !plan} onClick={() => { setError(""); setStage("review"); }}>Review changes</button>
        {dirty && <button className="secondary" onClick={() => { setDraft(committed); setError(""); }}>Discard</button>}
      </div>
    </>}

    {!pending && protection.kind !== "list-missing" && protection.kind !== "list-mismatch" && stage === "review" && plan && <>
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

function randomBytes32(): Hex {
  const value = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
