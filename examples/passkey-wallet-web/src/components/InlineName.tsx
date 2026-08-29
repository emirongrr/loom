import { useState } from "react";

/**
 * A name you can change, without a form standing open to ask you to.
 *
 * Reading is the resting state: the name, and a pencil beside it. A field and
 * a save button left visible on a page nobody came here to edit reads as a
 * form waiting to be filled in, and adds a decision to every visit.
 *
 * Used for both the wallet's own name and each guardian's, so the two behave
 * the same way rather than each inventing its own.
 */
export function InlineName({ label, value, placeholder, compact = false, onSave }: {
  /** What is being named, for the field and for the pencil's accessible name. */
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  /** Drop the label in places that already say what the name belongs to. */
  readonly compact?: boolean;
  readonly onSave: (name: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const trimmed = draft.trim();
  const changed = trimmed.length > 0 && trimmed !== value;

  const commit = async () => {
    if (!changed || busy) return;
    setBusy(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } finally { setBusy(false); }
  };

  const abandon = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return <div className={compact ? "inline-name compact" : "inline-name"}>
      <div>
        {!compact && <span className="eyebrow">{label}</span>}
        <strong>{value}</strong>
      </div>
      <button className="icon-button" aria-label={`Rename ${label.toLowerCase()}`} onClick={() => { setDraft(value); setEditing(true); }}>
        <PencilMark />
      </button>
    </div>;
  }

  return <div className="inline-name editing">
    <label className="field">
      <span>{label}</span>
      <input
        value={draft}
        maxLength={40}
        autoFocus
        disabled={busy}
        {...(placeholder ? { placeholder } : {})}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); void commit(); }
          if (event.key === "Escape") abandon();
        }}
      />
    </label>
    <div className="inline-name-actions">
      <button className="primary" disabled={!changed || busy} onClick={() => void commit()}>Save</button>
      <button className="text-button" disabled={busy} onClick={abandon}>Cancel</button>
    </div>
  </div>;
}

function PencilMark() {
  return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
    <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z M13.5 7.5l3 3"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
