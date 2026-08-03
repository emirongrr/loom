import { useState } from "react";
import type { AccountHandle } from "../../types";
import { shorten } from "../../components/AccountHeader";
import { Dialog } from "../../components/Dialog";

export function WalletLanding({ accounts, busy, message, onCreate, onImport, onOpen, onRemove, onClearMessage }: {
  readonly accounts: readonly AccountHandle[];
  readonly busy: boolean;
  readonly message: string;
  readonly onCreate: (label: string) => Promise<void>;
  readonly onImport: (text: string) => Promise<void>;
  readonly onOpen: (account: AccountHandle) => Promise<void>;
  readonly onRemove: (account: AccountHandle) => Promise<void>;
  readonly onClearMessage: () => void;
}) {
  const [mode, setMode] = useState<"welcome" | "create" | "recover">("welcome");
  const [label, setLabel] = useState("");
  const [backup, setBackup] = useState("");
  const [removing, setRemoving] = useState<AccountHandle | null>(null);
  const [removalConfirmation, setRemovalConfirmation] = useState("");
  const closeRemoval = () => {
    setRemoving(null);
    setRemovalConfirmation("");
  };
  const confirmRemoval = async () => {
    if (!removing || removalConfirmation !== "REMOVE") return;
    try {
      await onRemove(removing);
      closeRemoval();
    } catch { /* The parent reports a safe error and the dialog stays open for retry. */ }
  };
  return <main className="wallet-landing">
    <section className="landing-panel" aria-labelledby="landing-title">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p className="eyebrow">Local passkey wallet</p>
      <h1 id="landing-title">{mode === "create" ? "Create a wallet" : mode === "recover" ? "Recover a wallet" : "Your wallets stay on this device"}</h1>
      {mode === "welcome" && <>
        <p>Create a new passkey wallet or restore a public wallet handle you exported earlier. Private passkey material never enters browser storage.</p>
        <div className="landing-choices">
          <button className="choice-card" onClick={() => { onClearMessage(); setMode("create"); }}><span aria-hidden="true">＋</span><strong>Create wallet</strong><small>Create a real passkey and derive its Loom account.</small></button>
          <button className="choice-card" onClick={() => { onClearMessage(); setMode("recover"); }}><span aria-hidden="true">↺</span><strong>Recover wallet</strong><small>Restore a saved public handle; guardian recovery remains a separate on-chain flow.</small></button>
        </div>
      </>}
      {mode === "create" && <form onSubmit={event => { event.preventDefault(); void onCreate(label); }}>
        <label className="field"><span>Wallet name</span><input autoFocus value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="My wallet" /></label>
        <p className="form-note">Your authenticator will ask you to create a passkey. The derived account starts without guardian recovery until you configure guardians.</p>
        <div className="landing-actions"><button type="button" className="secondary" onClick={() => { onClearMessage(); setMode("welcome"); }}>Back</button><button className="primary" disabled={busy || !label.trim()}>{busy ? "Creating passkey…" : "Create with passkey"}</button></div>
      </form>}
      {mode === "recover" && <form onSubmit={event => { event.preventDefault(); void onImport(backup); }}>
        <label className="field"><span>Public wallet handle</span><textarea autoFocus value={backup} onChange={event => setBackup(event.target.value)} placeholder='Paste the exported version 1 JSON handle' rows={8} /></label>
        <p className="form-note">This restores public connection metadata only. The matching passkey must still be available; importing a handle does not bypass guardian approval or perform on-chain recovery.</p>
        <div className="landing-actions"><button type="button" className="secondary" onClick={() => { onClearMessage(); setMode("welcome"); }}>Back</button><button className="primary" disabled={busy || !backup.trim()}>{busy ? "Validating…" : "Restore handle"}</button></div>
      </form>}
      {message && <p className="toast" role="status">{message}</p>}
    </section>
    <section className="saved-wallets" aria-labelledby="saved-wallets-title">
      <div className="section-heading"><div><p className="eyebrow">Persistent local registry</p><h2 id="saved-wallets-title">Saved wallets</h2></div><span className="pill">{accounts.length}</span></div>
      {accounts.length === 0 ? <div className="empty-state compact"><h3>No wallets saved yet</h3><p>Created and restored handles remain listed here until you remove them.</p></div> : <div className="wallet-list">{accounts.map(account => <div key={account.id} className="wallet-list-item">
        <button className="wallet-list-open" disabled={busy} onClick={() => void onOpen(account)}>
          <span className="identicon" aria-hidden="true" /><span><strong>{account.label}</strong><small>{shorten(account.account)} · Chain {account.chainId}</small></span><span className="pill included">Open</span>
        </button>
        <button className="wallet-list-remove" disabled={busy} aria-label={`Remove ${account.label}`} onClick={() => { setRemovalConfirmation(""); setRemoving(account); }}>
          <svg className="wallet-list-remove-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M9 3h6m-9 4h12m-1 0-.6 12a2 2 0 0 1-2 2H9.6a2 2 0 0 1-2-2L7 7m3 4v6m4-6v6" /></svg>
          <span>Remove</span>
        </button>
      </div>)}</div>}
    </section>
    {removing && <Dialog label="Remove saved wallet" busy={busy} onClose={closeRemoval}>
      <div className="sheet-handle" aria-hidden="true" />
      <p className="eyebrow">Saved Wallets</p>
      <h2>Remove {removing.label}?</h2>
      <p>This removes its public connection metadata from this list. It does not delete the on-chain account, its passkey, guardian capabilities, or recovery records.</p>
      <div className="review-summary">
        <div><span>Account</span><strong>{shorten(removing.account)}</strong></div>
        <div><span>Network</span><strong>Chain {removing.chainId}</strong></div>
      </div>
      <p className="form-note">To add it again, restore an exported public handle with the matching passkey. Passkeys cannot be rediscovered by this website.</p>
      <div className="removal-confirmation">
        <div className="removal-warning" id="remove-wallet-warning"><span aria-hidden="true">!</span><p><strong>This action removes the wallet from this browser.</strong> Type REMOVE below to confirm.</p></div>
        <label className="field"><span>Type REMOVE to confirm</span><input autoFocus autoComplete="off" spellCheck={false} maxLength={6} value={removalConfirmation} aria-describedby="remove-wallet-warning" placeholder="REMOVE" onChange={event => setRemovalConfirmation(event.target.value)} /></label>
      </div>
      <div className="sheet-actions">
        <button className="secondary" disabled={busy} onClick={closeRemoval}>Cancel</button>
        <button className="danger-button" disabled={busy || removalConfirmation !== "REMOVE"} onClick={() => void confirmRemoval()}>{busy ? "Removing…" : "Remove from Saved Wallets"}</button>
      </div>
    </Dialog>}
  </main>;
}

export function WalletLock({ account, busy, message, onUnlock, onSwitch }: {
  readonly account: AccountHandle;
  readonly busy: boolean;
  readonly message: string;
  readonly onUnlock: () => Promise<void>;
  readonly onSwitch: () => void;
}) {
  return <main className="wallet-landing lock-layout">
    <section className="landing-panel" aria-labelledby="locked-wallet-title">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p className="eyebrow">Account locked</p>
      <h1 id="locked-wallet-title">{account.label}</h1>
      <p>{shorten(account.account)} · Chain {account.chainId}</p>
      <p className="form-note">Use the wallet's matching passkey to continue. Public metadata remains saved while locked.</p>
      <div className="landing-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onSwitch}>Switch account</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void onUnlock()}>{busy ? "Checking passkey…" : "Unlock with passkey"}</button>
      </div>
      {message && <p className="toast" role="status">{message}</p>}
    </section>
  </main>;
}
