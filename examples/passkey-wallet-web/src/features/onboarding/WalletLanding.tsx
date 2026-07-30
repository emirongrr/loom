import { useState } from "react";
import type { AccountHandle } from "../../types";
import { shorten } from "../../components/AccountHeader";
import { useNetwork } from "../../config/NetworkContext";
import { loadWalletDeployment } from "./accountLifecycle";
import { readVerifierCodeHash } from "../security/guardianClient";
import {
  assertAddable, buildGuardianDescriptor, clampThreshold, describeGuardian, suggestedThreshold,
  type RosterEntry
} from "../security/guardianPlan";
import { AddGuardianForm } from "../security/AddGuardianForm";
import { createLoomGuardianChainReader, detectGuardianAddress, resolveLoomP256Guardian } from "../security/loomGuardian";

export interface WalletCreationRequest {
  readonly label: string;
  readonly guardians?: { readonly entries: readonly RosterEntry[]; readonly threshold: number };
}

export function WalletLanding({ accounts, busy, message, onCreate, onImport, onOpen, onGuardianRecover, onClearMessage }: {
  readonly accounts: readonly AccountHandle[];
  readonly busy: boolean;
  readonly message: string;
  readonly onCreate: (request: WalletCreationRequest) => Promise<void>;
  readonly onImport: (text: string) => Promise<void>;
  readonly onOpen: (account: AccountHandle) => Promise<void>;
  readonly onGuardianRecover: () => void;
  readonly onClearMessage: () => void;
}) {
  const { config } = useNetwork();
  const [mode, setMode] = useState<"welcome" | "create" | "recover">("welcome");
  const [label, setLabel] = useState("");
  const [backup, setBackup] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [guardians, setGuardians] = useState<readonly RosterEntry[]>([]);
  const [threshold, setThreshold] = useState(1);
  const [guardianBusy, setGuardianBusy] = useState(false);
  const [guardianError, setGuardianError] = useState("");
  const [ceremonyConfirmed, setCeremonyConfirmed] = useState(false);

  const addGuardian = async (guardianLabel: string, value: string) => {
    setGuardianBusy(true); setGuardianError("");
    try {
      const deployment = await loadWalletDeployment();
      const chainReader = createLoomGuardianChainReader(config, deployment);
      const detected = await detectGuardianAddress(value, chainReader);
      const verifier = detected.kind === "loom" ? deployment.guardianVerifiers?.p256 : detected.kind === "ecdsa" ? deployment.guardianVerifiers?.ecdsa : deployment.guardianVerifiers?.erc1271;
      if (!verifier) throw new Error("This deployment cannot verify this guardian address type.");
      const verifierCodeHash = await readVerifierCodeHash(config, verifier);
      const descriptor = detected.kind === "loom"
        ? await resolveLoomP256Guardian({ value, deployment, verifierCodeHash, reader: chainReader })
        : buildGuardianDescriptor({ kind: detected.kind, value: detected.address, verifier, verifierCodeHash });
      assertAddable(guardians, descriptor);
      const entry: RosterEntry = Object.freeze({
        id: crypto.randomUUID(),
        label: guardianLabel.trim() || describeGuardian(descriptor).slice(0, 10),
        descriptor
      });
      const next = Object.freeze([...guardians, entry]);
      setGuardians(next);
      setCeremonyConfirmed(false);
      setThreshold(current => current === suggestedThreshold(guardians.length) ? suggestedThreshold(next.length) : clampThreshold(current, next.length));
      if (detected.warning) setGuardianError(detected.warning);
    } catch (issue) {
      setGuardianError(issue instanceof Error ? issue.message : "The guardian could not be added.");
    } finally { setGuardianBusy(false); }
  };

  const removeGuardian = (id: string) => {
    const next = guardians.filter(entry => entry.id !== id);
    setGuardians(next);
    setThreshold(current => clampThreshold(current, next.length));
    setCeremonyConfirmed(false);
    setGuardianError("");
  };

  const create = () => onCreate({
    label,
    ...(advanced ? { guardians: { entries: guardians, threshold } } : {})
  });
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
      {mode === "create" && <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <label className="field"><span>Wallet name</span><input autoFocus value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="My wallet" /></label>
        <label className="advanced-toggle">
          <input type="checkbox" checked={advanced} onChange={event => { setAdvanced(event.target.checked); setGuardianError(""); }} />
          <span><strong>Set up guardians now</strong><small>Advanced · bind recovery protection into the wallet from its first deployment.</small></span>
        </label>
        {advanced && <div className="advanced-setup">
          <div><p className="eyebrow">Initial recovery</p><h3>Choose independent guardians</h3></div>
          <p className="form-note">Guardian identities stay encrypted on this device. Only their Merkle root and approval threshold are committed to the account.</p>
          {guardians.length > 0 && <div className="guardian-list">{guardians.map(entry => <div className="guardian-row" key={entry.id}>
            <span className="round-icon" aria-hidden="true">{entry.descriptor.kind === "erc1271" ? "▣" : "◆"}</span>
            <div><strong>{entry.label}</strong><p className="breakable">{describeGuardian(entry.descriptor)}</p></div>
            <button type="button" className="text-button" onClick={() => removeGuardian(entry.id)}>Remove</button>
          </div>)}</div>}
          <AddGuardianForm busy={busy || guardianBusy} onAdd={(name, value) => void addGuardian(name, value)} />
          {guardians.length > 0 && <label className="field"><span>Approvals needed to recover</span>
            <select value={threshold} onChange={event => setThreshold(Number(event.target.value))}>
              {guardians.map((_, index) => index + 1).map(value => <option key={value} value={value}>{value} of {guardians.length}</option>)}
            </select>
            <small className="form-note">A majority is recommended. Use guardians controlled by separate people or security domains.</small>
          </label>}
          <p className="callout warning">This example rechecks verifier bytecode through your configured RPC, but its deployment file does not yet pin audited verifier code hashes. Verify the deployment before using production funds.</p>
          {guardians.length > 0 && <label className="advanced-toggle compact-toggle">
            <input type="checkbox" checked={ceremonyConfirmed} onChange={event => setCeremonyConfirmed(event.target.checked)} />
            <span><strong>I verified every guardian</strong><small>Each guardian independently confirmed control of the listed address and their ability to approve this wallet's recovery requests.</small></span>
          </label>}
          {guardianError && <p className="callout warning">{guardianError}</p>}
        </div>}
        <p className="form-note">Your authenticator will ask you to create a passkey. {advanced ? "The account address will commit to this guardian set and recovery module." : "The derived account starts without guardian recovery until you configure guardians."}</p>
        <div className="landing-actions"><button type="button" className="secondary" onClick={() => { onClearMessage(); setMode("welcome"); }}>Back</button><button className="primary" disabled={busy || guardianBusy || !label.trim() || (advanced && (guardians.length === 0 || !ceremonyConfirmed))}>{busy ? "Creating passkey…" : advanced ? "Create protected wallet" : "Create with passkey"}</button></div>
      </form>}
      {mode === "recover" && <form onSubmit={event => { event.preventDefault(); void onImport(backup); }}>
        <div className="callout"><strong>Lost the passkey?</strong><p>Use guardian recovery to replace account control after threshold approval and the contract delay.</p><button type="button" className="secondary" onClick={onGuardianRecover}>Start guardian recovery</button></div>
        <label className="field"><span>Public wallet handle</span><textarea autoFocus value={backup} onChange={event => setBackup(event.target.value)} placeholder='Paste the exported version 1 JSON handle' rows={8} /></label>
        <p className="form-note">This restores public connection metadata only. The matching passkey must still be available; importing a handle does not bypass guardian approval or perform on-chain recovery.</p>
        <div className="landing-actions"><button type="button" className="secondary" onClick={() => { onClearMessage(); setMode("welcome"); }}>Back</button><button className="primary" disabled={busy || !backup.trim()}>{busy ? "Validating…" : "Restore handle"}</button></div>
      </form>}
      {message && <p className="toast" role="status">{message}</p>}
    </section>
    <section className="saved-wallets" aria-labelledby="saved-wallets-title">
      <div className="section-heading"><div><p className="eyebrow">Persistent local registry</p><h2 id="saved-wallets-title">Saved wallets</h2></div><span className="pill">{accounts.length}</span></div>
      {accounts.length === 0 ? <div className="empty-state compact"><h3>No wallets saved yet</h3><p>Created and restored handles will remain listed here. This screen never deletes or silently evicts them.</p></div> : <div className="wallet-list">{accounts.map(account => <button key={account.id} className="wallet-list-item" disabled={busy} onClick={() => void onOpen(account)}>
        <span className="identicon" aria-hidden="true" /><span><strong>{account.label}</strong><small>{shorten(account.account)} · Chain {account.chainId}</small></span><span className="pill included">Open</span>
      </button>)}</div>}
    </section>
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
