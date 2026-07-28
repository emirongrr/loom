import { formatCountdown, formatReadyAt } from "./guardianPlan";
import type { PendingChangeStatus } from "./pendingChange";
import type { RosterPending } from "../../storage/guardianRosterRecord";

/** A scheduled guardian change, counted down from the chain's own clock. */
export function PendingChangeCard({ pending, status, statusError, busy, onExecute, onCancel, onForget, onRefresh, tick }: {
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
