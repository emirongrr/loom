import { useEffect, useState } from "react";
import type { AccountHandle } from "../../types";
import { Dialog } from "../../components/Dialog";
import { useNetwork } from "../../config/NetworkContext";
import { readVerifierCodeHash } from "../security/guardianClient";
import {
  assertAddable, buildGuardianDescriptor, clampThreshold, createRosterEntry, describeGuardian, suggestedThreshold,
  type RosterEntry
} from "../security/guardianPlan";
import { AddGuardianForm } from "../security/AddGuardianForm";
import { createLoomGuardianChainReader, detectGuardianAddress, resolveLoomP256Guardian } from "../security/loomGuardian";
import { useAppServices } from "../../app/AppServices";
import { describeWalletRecovery, readWalletsBeingRecovered, type WalletRecovery } from "../wallet/walletsBeingRecovered";
import { createAccountGuardianClient } from "../security/guardianClient";
import { loadWalletDeployment } from "./accountLifecycle";
import { shortAddress } from "../../components/address.ts";

export interface WalletCreationRequest {
  readonly label: string;
  readonly guardians?: { readonly entries: readonly RosterEntry[]; readonly threshold: number };
}

export function WalletLanding({ accounts, busy, message, onCreate, onOpen, onRemove, onGuardianRecover, onFindByPasskey, onClearMessage }: {
  readonly accounts: readonly AccountHandle[];
  readonly busy: boolean;
  readonly message: string;
  readonly onCreate: (request: WalletCreationRequest) => Promise<void>;
  readonly onOpen: (account: AccountHandle) => Promise<void>;
  readonly onRemove: (account: AccountHandle) => Promise<void>;
  readonly onGuardianRecover: () => void;
  readonly onFindByPasskey: () => Promise<void>;
  readonly onClearMessage: () => void;
}) {
  const { config } = useNetwork();
  const { publicClients, now } = useAppServices();
  const [mode, setMode] = useState<"welcome" | "create" | "recover">("welcome");
  const [label, setLabel] = useState("");
  const [removing, setRemoving] = useState<AccountHandle | null>(null);
  /** Which saved wallets have a recovery under way, read from each account. */
  const [beingRecovered, setBeingRecovered] = useState<ReadonlyMap<string, WalletRecovery>>(new Map());
  const [removalConfirmation, setRemovalConfirmation] = useState("");
  useEffect(() => {
    if (accounts.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const deployment = await loadWalletDeployment();
        if (!deployment.recoveryModule) return;
        const flags = await readWalletsBeingRecovered({
          accounts,
          chainId: deployment.chainId,
          nowSeconds: Math.floor(now() / 1000),
          readPending: async account => {
            const client = createAccountGuardianClient({
              config, chainId: deployment.chainId, account,
              recoveryManager: deployment.recoveryModule!, publicClients
            });
            const record = await client.readPendingRecovery();
            return { pending: record.pending, readyAt: record.readyAt, expiresAt: record.expiresAt };
          }
        });
        if (!cancelled) setBeingRecovered(flags);
      } catch {
        // Not knowing is left as not knowing: the rows say nothing rather than
        // saying nothing is wrong.
      }
    })();
    return () => { cancelled = true; };
  }, [accounts, config, publicClients, now]);

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
      const chainReader = createLoomGuardianChainReader(config, deployment, publicClients);
      const detected = await detectGuardianAddress(value, chainReader);
      const verifier = detected.kind === "loom" ? deployment.guardianVerifiers?.p256 : detected.kind === "ecdsa" ? deployment.guardianVerifiers?.ecdsa : deployment.guardianVerifiers?.erc1271;
      if (!verifier) throw new Error("This deployment cannot verify this guardian address type.");
      const verifierCodeHash = await readVerifierCodeHash(config, verifier, publicClients);
      const descriptor = detected.kind === "loom"
        ? await resolveLoomP256Guardian({ value, deployment, verifierCodeHash, reader: chainReader })
        : buildGuardianDescriptor({ kind: detected.kind, value: detected.address, verifier, verifierCodeHash });
      assertAddable(guardians, descriptor);
      const entry = createRosterEntry({ label: guardianLabel, descriptor, guardianAccount: detected.address });
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
      <h1 id="landing-title">{mode === "create" ? "Create a wallet" : mode === "recover" ? "Recover a wallet" : "Welcome to Loom"}</h1>
      {mode === "welcome" && <>
        {/* One sentence, and the one thing that distinguishes this wallet from
            the others someone might have used: the key is the device's, not an
            account with a company. */}
        <p>A wallet you unlock with this device. No seed phrase, no account with anyone.</p>
        <div className="landing-choices">
          <button className="choice-card" onClick={() => { onClearMessage(); setMode("create"); }}><span aria-hidden="true">＋</span><strong>Create wallet</strong><small>Start a new one with a passkey on this device.</small></button>
          <button className="choice-card" onClick={() => { onClearMessage(); setMode("recover"); }}><span aria-hidden="true">↺</span><strong>Recover wallet</strong><small>Bring back a wallet with its passkey, an exported handle, or your guardians.</small></button>
        </div>
      </>}
      {mode === "create" && <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <label className="field"><span>Wallet name</span><input autoFocus value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="My wallet" /></label>
        <p className="form-note">One flow opens your browser's secure passkey picker. Depending on your device it may offer Windows Hello, a phone or cloud-synced provider, or a hardware key such as YubiKey. A sponsored deployment asks you to use the new passkey once more to sign its on-chain activation.</p>
        <label className="advanced-toggle">
          <input type="checkbox" checked={advanced} onChange={event => { setAdvanced(event.target.checked); setGuardianError(""); }} />
          <span><strong>Set up guardians now</strong><small>Advanced · bind recovery protection into the wallet from its first deployment.</small></span>
        </label>
        {advanced && <div className="advanced-setup">
          <div><p className="eyebrow">Recovery</p><h3>Guardians</h3></div>
          {/* What someone choosing guardians needs: that their names stay
              private, and that picking people who could not all be reached at
              once is the point. How the set is committed is not their concern. */}
          <p className="form-note">Their names stay on this device. Choose people who would not all be unreachable at the same time.</p>
          {guardians.length > 0 && <div className="guardian-list">{guardians.map(entry => <div className="guardian-row" key={entry.id}>
            <span className="round-icon" aria-hidden="true">{entry.descriptor.kind === "erc1271" ? "▣" : "◆"}</span>
            <div><strong>{entry.label}</strong><p className="breakable">{entry.guardianAccount ?? describeGuardian(entry.descriptor)}</p></div>
            <button type="button" className="text-button" onClick={() => removeGuardian(entry.id)}>Remove</button>
          </div>)}</div>}
          <AddGuardianForm busy={busy || guardianBusy} onAdd={(name, value) => void addGuardian(name, value)} />
          {guardians.length > 0 && <label className="field"><span>Approvals needed to recover</span>
            <select value={threshold} onChange={event => setThreshold(Number(event.target.value))}>
              {guardians.map((_, index) => index + 1).map(value => <option key={value} value={value}>{value} of {guardians.length}</option>)}
            </select>
            <small className="form-note">A majority is a good default.</small>
          </label>}
          {guardians.length > 0 && <label className="advanced-toggle compact-toggle">
            <input type="checkbox" checked={ceremonyConfirmed} onChange={event => setCeremonyConfirmed(event.target.checked)} />
            <span><strong>I verified every guardian</strong><small>Each guardian independently confirmed control of the listed address and their ability to approve this wallet's recovery requests.</small></span>
          </label>}
          {guardianError && <p className="callout warning">{guardianError}</p>}
        </div>}
        <div className="landing-actions"><button type="button" className="secondary" onClick={() => { onClearMessage(); setMode("welcome"); }}>Back</button><button className="primary" disabled={busy || guardianBusy || !label.trim() || (advanced && (guardians.length === 0 || !ceremonyConfirmed))}>{busy ? "Creating wallet…" : advanced ? "Create protected wallet" : "Create with passkey"}</button></div>
      </form>}
      {mode === "recover" && <div>
        {/* Two ways back, and the question that separates them is simply
            whether the passkey is still reachable. */}
        <div className="callout">
          <strong>Still have the passkey?</strong>
          {/* One passkey per attempt, because that is all a browser will give:
              the picker shows what is on the device and returns the one chosen.
              A site cannot list them, which is what stops any site from
              fingerprinting a person by their credentials. Repeating is the way
              to bring back several, so the wording invites it. */}
          <p>
            Use it to find the activated on-chain account it still controls. Nothing needs to have been exported
            first, and you can repeat this for each passkey you hold — your browser asks which one to use.
          </p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void onFindByPasskey()}>
            {accounts.length > 0 ? "Find another with a passkey" : "Find with a passkey"}
          </button>
        </div>
        <div className="callout"><strong>Lost the passkey?</strong><p>Use guardian recovery to replace account control after threshold approval and the contract delay.</p><button type="button" className="secondary" onClick={onGuardianRecover}>Start guardian recovery</button></div>
        <div className="landing-actions"><button type="button" className="secondary" onClick={() => { onClearMessage(); setMode("welcome"); }}>Back</button></div>
      </div>}
      {message && <p className="toast" role="status">{message}</p>}
    </section>
    <section className="saved-wallets" aria-labelledby="saved-wallets-title">
      <div className="section-heading"><div><p className="eyebrow">Persistent local registry</p><h2 id="saved-wallets-title">Saved wallets</h2></div><span className="pill">{accounts.length}</span></div>
      {accounts.length === 0 ? <div className="empty-state compact"><h3>No wallets saved yet</h3><p>Created and restored handles remain listed here until you remove them.</p></div> : <div className="wallet-list">{accounts.map(account => {
        const recovery = describeWalletRecovery(beingRecovered.get(account.id));
        return <div key={account.id} className="wallet-list-item">
        <button className="wallet-list-open" disabled={busy} onClick={() => void onOpen(account)}>
          <span className="identicon" aria-hidden="true" /><span><strong>{account.label}</strong><small>{shortAddress(account.account)} · Chain {account.chainId}</small></span>
          {/* Both badges in one cell. The row is a three-column grid, and a
              fourth child drops to a line of its own -- which is how the same
              mistake looked on the recovery list. */}
          <span className="wallet-list-badges">
            {/* Said on the wallet rather than only inside it. The delay exists
                so an owner has time to object, and they cannot object to
                something their own list never mentions. */}
            {recovery && <span className={recovery.urgent ? "pill failed" : "pill"}>{recovery.label}</span>}
            <span className="pill included">Open</span>
          </span>
        </button>
        <button className="wallet-list-remove" disabled={busy} aria-label={`Remove ${account.label}`} onClick={() => { setRemovalConfirmation(""); setRemoving(account); }}>
          <svg className="wallet-list-remove-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M9 3h6m-9 4h12m-1 0-.6 12a2 2 0 0 1-2 2H9.6a2 2 0 0 1-2-2L7 7m3 4v6m4-6v6" /></svg>
          <span>Remove</span>
        </button>
        {recovery && <p className={recovery.urgent ? "callout warning" : "form-note"}>{recovery.detail}</p>}
      </div>;
      })}</div>}
    </section>
    {removing && <Dialog label="Remove saved wallet" busy={busy} onClose={closeRemoval}>
      <div className="sheet-handle" aria-hidden="true" />
      <p className="eyebrow">Saved Wallets</p>
      <h2>Remove {removing.label}?</h2>
      <p>This removes its public connection metadata from this list. It does not delete the on-chain account, its passkey, guardian capabilities, or recovery records.</p>
      <div className="review-summary">
        <div><span>Account</span><strong>{shortAddress(removing.account)}</strong></div>
        <div><span>Network</span><strong>Chain {removing.chainId}</strong></div>
      </div>
      <p className="form-note">To add an activated wallet again, use Find with a passkey. A wallet that has never been created on chain is still only known to this browser.</p>
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
      <p>{shortAddress(account.account)} · Chain {account.chainId}</p>
      <p className="form-note">Use the wallet's matching passkey to continue. Public metadata remains saved while locked.</p>
      <div className="landing-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onSwitch}>Switch account</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void onUnlock()}>{busy ? "Checking passkey…" : "Unlock with passkey"}</button>
      </div>
      {message && <p className="toast" role="status">{message}</p>}
    </section>
  </main>;
}
