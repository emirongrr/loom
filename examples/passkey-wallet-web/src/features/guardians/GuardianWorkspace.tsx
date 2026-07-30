import { useEffect, useState } from "react";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { parseGuardianInvite } from "@loom/sdk/recovery";
import { receiveGuardianInvite } from "../../transports/invitations";
import { shorten } from "../../components/AccountHeader";
import { useAppServices } from "../../app/AppServices";
import { FreezeDialog } from "./FreezeDialog";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import type { GuardianVaultIssue, GuardianVaultRecord } from "../../storage/guardianVault";
import type { AccountHandle } from "../../types";

export function GuardianWorkspace({ account }: { readonly account: AccountHandle }) {
  const services = useAppServices();
  const [records, setRecords] = useState<readonly GuardianVaultRecord[]>([]);
  const [issues, setIssues] = useState<readonly GuardianVaultIssue[]>([]);
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [freezing, setFreezing] = useState<GuardianInviteV1 | null>(null);
  const refresh = () => services.guardianVault.inspect(account)
    .then(snapshot => { setRecords(snapshot.records); setIssues(snapshot.issues); })
    .catch(error => setMessage(error instanceof Error ? error.message : "Guardian vault unavailable"));
  useEffect(() => {
    let active = true;
    // Clear synchronously so a wallet switch cannot render the previous
    // wallet's protected-account relationships while the scoped read runs.
    setRecords([]);
    setIssues([]);
    setFreezing(null);
    setMessage("");
    services.guardianVault.inspect(account)
      .then(snapshot => {
        if (!active) return;
        setRecords(snapshot.records);
        setIssues(snapshot.issues);
      })
      .catch(error => {
        if (active) setMessage(error instanceof Error ? error.message : "Guardian vault unavailable");
      });
    return () => { active = false; };
  }, [services.guardianVault, account.id, account.chainId, account.account, account.publicKey.x, account.publicKey.y]);
  useEffect(() => {
    let active = true;
    loadWalletDeployment().then(result => { if (active) setDeployment(result); }).catch(() => { if (active) setDeployment(null); });
    return () => { active = false; };
  }, []);
  const accept = async () => {
    try {
      const invite = link.trim().startsWith("{")
        ? parseGuardianInvite(link)
        : await receiveGuardianInvite(link, services.invitationLinks, Math.floor(services.now() / 1000));
      await services.guardianVault.put(account, { capability: invite, acceptedAt: services.now(), status: "unverified" });
      setMessage("Capability validated and encrypted. Live account state must match before guardian actions are enabled."); setLink(""); refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Capability could not be accepted"); }
  };
  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Guardian workspace</p><h1>Accounts I protect</h1><p>This private list exists only on this device. The chain cannot enumerate it.</p></header>
    <section className="privacy-banner"><span aria-hidden="true">◌</span><div><strong>Local and encrypted</strong><p>Capabilities use authenticated browser encryption. This reduces casual storage disclosure, but an XSS running on this origin can still use the device key.</p></div></section>
    <section className="section-card"><div className="section-heading"><div><p className="eyebrow">Accept an invitation</p><h2>Encrypted link or QR payload</h2></div><span className="pill">Private</span></div>
      <label className="field"><span>Invitation</span><input value={link} onChange={event => setLink(event.target.value)} placeholder="https://wallet.example/guardian#cap=…" /></label>
      <button className="primary" onClick={accept} disabled={!link.trim()}>Review invitation</button>
      <details><summary>Advanced / portable file fallback</summary><p>Paste a versioned JSON capability exported from an independent wallet. It contains only your proof, never the full guardian set.</p></details>
      {message && <p className="toast" role="status">{message}</p>}
    </section>
    {issues.length > 0 && <section className="section-card" aria-labelledby="guardian-vault-issues"><div className="section-heading"><div><p className="eyebrow">Local vault maintenance</p><h2 id="guardian-vault-issues">Unreadable records</h2></div><span className="pill failed">{issues.length}</span></div>
      <p>These encrypted records failed authentication or validation. Healthy guardian accounts remain available.</p>
      {issues.map(issue => <div className="guardian-actions" key={String(issue.key)}><span>{issue.message}</span><button className="secondary" onClick={async () => {
        try { await services.guardianVault.remove(issue.key); await refresh(); setMessage("Unreadable local record removed."); }
        catch (error) { setMessage(error instanceof Error ? error.message : "Unreadable record could not be removed"); }
      }}>Remove local record</button></div>)}
    </section>}
    {records.length === 0 ? <section className="empty-state"><span aria-hidden="true">◇</span><h2>No accepted accounts</h2><p>Open an encrypted invitation or scan its QR code. Generating an invite alone never marks it delivered or accepted.</p></section> : records.map(record => <GuardianAccount key={record.capability.capabilityId} record={record} onFreeze={() => setFreezing(record.capability)} />)}
    {freezing && deployment && <FreezeDialog capability={freezing} deployment={deployment} onClose={() => setFreezing(null)} />}
  </div>;
}

function GuardianAccount({ record, onFreeze }: { record: GuardianVaultRecord; onFreeze(): void }) {
  const invite: GuardianInviteV1 = record.capability;
  return <article className="section-card guardian-account"><div className="section-heading"><div><p className="eyebrow">{invite.accountAlias}</p><h2>{shorten(invite.account)}</h2></div><span className={`pill ${record.status === "stale" ? "failed" : "included"}`}>{record.status}</span></div>
    <div className="permission-grid"><div><span>Chain</span><strong>{invite.chainId}</strong></div><div><span>Guardian type</span><strong>{invite.guardian.kind === "p256" ? "Dedicated passkey" : invite.guardian.kind.toUpperCase()}</strong></div><div><span>Threshold</span><strong>{invite.threshold} of {invite.guardianCount}</strong></div><div><span>Accepted</span><strong>{new Date(record.acceptedAt).toLocaleDateString()}</strong></div></div>
    <p className="form-note">Freezing pauses this account's ordinary execution for the contract's emergency window. It moves no funds, approves no recovery, and gives you no spending power.</p>
    <div className="guardian-actions"><button className="danger-button" onClick={onFreeze}>Emergency freeze…</button></div>
  </article>;
}
