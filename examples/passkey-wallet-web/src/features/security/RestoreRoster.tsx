import { useState } from "react";
import type { GuardianStatus } from "./guardianStatus";

/** Shown when the account is guardian-protected but this device cannot rebuild the
 * set. A restored list is only ever accepted because it reproduces the account's
 * own guardian root. */
export function RestoreRoster({ status, busy, error, onRestore, onReenter, onDismissError }: {
  status: Extract<GuardianStatus, { kind: "list-missing" | "list-mismatch" }>;
  busy: boolean;
  error: string;
  onRestore(text: string): void;
  onReenter(addresses: readonly { label: string; value: string }[]): void;
  onDismissError(): void;
}) {
  const [rows, setRows] = useState<{ label: string; value: string }[]>([{ label: "", value: "" }]);
  const [text, setText] = useState("");
  const missing = status.kind === "list-missing";
  const filled = rows.filter(row => row.value.trim() !== "");

  const update = (index: number, patch: Partial<{ label: string; value: string }>) => {
    onDismissError();
    setRows(current => current.map((row, position) => position === index ? { ...row, ...patch } : row));
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    onDismissError();
    onRestore(await file.text());
  };

  return <div className="pending-change">
    <div className="pending-head">
      <div>
        <p className="eyebrow">Protected on chain</p>
        <h3>{status.threshold} approvals can recover this account</h3>
      </div>
      <span className="pill pending">List missing</span>
    </div>

    <p className="form-note">
      {missing
        ? "The account publishes a guardian root, so guardians are configured — but this device does not hold the list of who they are."
        : "The list on this device does not rebuild the account's guardian root, so it is out of date or belongs to a different set."}
      {" "}Guardian identities are never published: only a root and a threshold are on chain. Recovery still works — this only affects editing the set from here.
    </p>

    <p className="callout">
      Enter the guardians again and this wallet will check them against the account itself. Each guardian is committed
      with a private value derived from your passkey, so the list is rebuilt only if your passkey is present and the
      addresses are exactly right — a wrong or guessed list cannot reproduce the account's root.
    </p>

    <div className="guardian-list">
      {rows.map((row, index) => <div className="restore-row" key={index}>
        <input value={row.label} maxLength={80} disabled={busy} placeholder={`Name (optional)`}
          onChange={event => update(index, { label: event.target.value })} />
        <input value={row.value} disabled={busy} placeholder="0x…" spellCheck={false} autoComplete="off"
          onChange={event => update(index, { value: event.target.value })} />
        <button className="text-button" disabled={busy || rows.length === 1}
          onClick={() => { onDismissError(); setRows(current => current.filter((_, position) => position !== index)); }}>Remove</button>
      </div>)}
    </div>

    <div className="guardian-actions">
      <button className="secondary" disabled={busy} onClick={() => setRows(current => [...current, { label: "", value: "" }])}>Add another</button>
      <button className="primary" disabled={busy || filled.length === 0} onClick={() => onReenter(filled)}>
        {busy ? "Checking against the account…" : "Verify with passkey"}
      </button>
    </div>

    {error && <p className="callout warning">{error}</p>}

    <details>
      <summary>Restore from an exported backup instead</summary>
      <p className="form-note">
        Use this if the account's guardians were set up on an authenticator that cannot re-derive their private values.
      </p>
      <label className="field"><span>Backup file</span>
        <input type="file" accept="application/json,.json" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} />
      </label>
      <label className="field"><span>Or paste its contents</span>
        <textarea value={text} rows={4} spellCheck={false} disabled={busy}
          onChange={event => { setText(event.target.value); onDismissError(); }}
          placeholder='{"format":"loom.guardian-roster",…}' />
      </label>
      <button className="secondary" disabled={busy || text.trim() === ""} onClick={() => onRestore(text)}>Restore and verify</button>
    </details>

    <p className="form-note">
      Still no match? Your guardians continue to protect the account. To manage them from this device again, schedule a
      new guardian set — that replaces the root with one this device knows.
    </p>
  </div>;
}
