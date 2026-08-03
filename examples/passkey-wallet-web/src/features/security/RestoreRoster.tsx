import { useState } from "react";
import type { GuardianStatus } from "./guardianStatus";

/** Shown when the account is guardian-protected but this device cannot rebuild the
 * set. A restored list is only ever accepted because it reproduces the account's
 * own guardian root. */
export function RestoreRoster({ status, busy, error, onRestore, onDismissError }: {
  status: Extract<GuardianStatus, { kind: "list-missing" | "list-mismatch" }>;
  busy: boolean;
  error: string;
  onRestore(text: string): void;
  onDismissError(): void;
}) {
  const [text, setText] = useState("");
  const missing = status.kind === "list-missing";

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
      Restore the private roster backup created for this guardian epoch. Guardian salts are random and are not derived
      from your passkey, so knowing or guessing guardian addresses cannot reproduce the account's root.
    </p>

    {error && <p className="callout warning">{error}</p>}

    <details open>
      <summary>Restore an exported roster</summary>
      <p className="form-note">
        The file is accepted only when its entries reconstruct this account's current on-chain root and threshold.
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
