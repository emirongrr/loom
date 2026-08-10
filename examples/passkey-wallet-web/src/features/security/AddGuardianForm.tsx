import { useState } from "react";

export function AddGuardianForm({ busy, onAdd }: {
  busy: boolean;
  onAdd(label: string, value: string): void;
}) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const submit = () => { onAdd(label, value); setLabel(""); setValue(""); };
  return <details className="add-guardian">
    <summary>Add a guardian</summary>
    <div className="add-guardian-body">
      <label className="field"><span>Name (only you see this)</span>
        <input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="Alex" />
      </label>
      <label className="field"><span>Address</span>
        <input value={value} onChange={event => setValue(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
      </label>
      <p className="form-note">Loom checks the chain while adding the guardian. A registered Loom wallet uses its pinned P-256 key; an address without code uses ECDSA. A deployed contract uses ERC-1271 and shows a warning if its signature interface cannot be confirmed by a safe probe. The verifier type cannot change during approval.</p>
      <button type="button" className="secondary" disabled={busy || value.trim() === ""} onClick={submit}>{busy ? "Checking on-chain authority…" : "Add to list"}</button>
    </div>
  </details>;
}
