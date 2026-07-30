import { useState } from "react";

export function AddGuardianForm({ busy, onAdd, hasErc1271 }: {
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
