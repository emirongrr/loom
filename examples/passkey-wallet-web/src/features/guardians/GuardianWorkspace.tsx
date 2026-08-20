import { useEffect, useState } from "react";
import type { GuardianInviteV1, RecoveryRequestV1 } from "@loom/sdk/recovery";
import { parseGuardianInvite, parseRecoveryRequest } from "@loom/sdk/recovery";
import { receiveGuardianInvite } from "../../transports/invitations";
import { shorten } from "../../components/AccountHeader";
import { useAppServices } from "../../app/AppServices";
import { FreezeDialog } from "./FreezeDialog";
import { SignWithoutInvitation } from "./SignWithoutInvitation";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import type { GuardianVaultIssue, GuardianVaultRecord } from "../../storage/guardianVault";
import { GUARDIAN_ACCOUNT_LABEL } from "../security/guardianInvitation";
import type { AccountHandle } from "../../types";
import { safeUserMessage } from "../../domain/errors/appError";
import { guardianVaultRecordsForAccount, reviewableGuardianCapabilitiesForAccount } from "../../storage/guardianVaultScope";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import { RecoveryApprovalDialog } from "./RecoveryApprovalDialog";
import { useNetwork } from "../../config/NetworkContext";
import { createRecoveryLogTransport } from "../../transports/recoveryLogs";
import { createAccountGuardianClient } from "../security/guardianClient";
import { discoverGuardianRecoveryRequests } from "./guardianDiscovery";
import type { DiscoveredRequestView } from "./discoveredRequests";

export function GuardianWorkspace({ account, inboundLink = "" }: { readonly account: AccountHandle; readonly inboundLink?: string }) {
  const services = useAppServices();
  const [records, setRecords] = useState<readonly GuardianVaultRecord[]>([]);
  const [issues, setIssues] = useState<readonly GuardianVaultIssue[]>([]);
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [freezing, setFreezing] = useState<GuardianInviteV1 | null>(null);
  const [recoveryArtifact, setRecoveryArtifact] = useState("");
  const [approving, setApproving] = useState<{ readonly request: RecoveryRequestV1; readonly capability: GuardianInviteV1; readonly alreadyPublished?: boolean } | null>(null);
  const { config } = useNetwork();
  const [discovery, setDiscovery] = useState<{
    readonly status: "idle" | "checking" | "done";
    readonly requests: readonly DiscoveredRequestView[];
    readonly rolledBack: readonly string[];
    readonly unavailable?: string;
  }>({ status: "idle", requests: [], rolledBack: [] });
  const refresh = () => services.guardianVault.inspect(account)
    .then(snapshot => { setRecords(snapshot.records); setIssues(snapshot.issues); })
    .catch(error => setMessage(safeUserMessage(error, "Guardian vault unavailable.", "storage")));
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
        if (active) setMessage(safeUserMessage(error, "Guardian vault unavailable.", "storage"));
    });
    return () => { active = false; };
  }, [services.guardianVault, account.id, account.chainId, account.account, account.publicKey.x, account.publicKey.y]);
  useEffect(() => {
    let active = true;
    loadWalletDeployment().then(result => { if (active) setDeployment(result); }).catch(() => { if (active) setDeployment(null); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setFreezing(null);
    setApproving(null);
    setRecoveryArtifact("");
    setMessage("");
  }, [account.id]);
  useEffect(() => {
    if (!inboundLink) return;
    void createEncryptedLinkTransport<unknown>({ origin: window.location.origin }).receive(inboundLink)
      .then(payload => {
        if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).format !== "loom.recovery-request") {
          setLink(inboundLink);
          return;
        }
        const request = parseRecoveryRequest(payload);
        const matchesOpenWallet = reviewableGuardianCapabilitiesForAccount(records, account, Math.floor(services.now() / 1000)).some(record =>
          record.capability.chainId === request.chainId
          && record.capability.account.toLowerCase() === request.account.toLowerCase()
        );
        if (matchesOpenWallet) setRecoveryArtifact(inboundLink);
        else if (records.length > 0) setMessage("The open wallet has no accepted guardian capability for this recovery request.");
      })
      .catch(() => setMessage("The incoming guardian link could not be opened."));
  }, [account, inboundLink, records, services]);
  const accept = async () => {
    try {
      const invite = link.trim().startsWith("{")
        ? parseGuardianInvite(link)
        : await receiveGuardianInvite(link, services.invitationLinks, Math.floor(services.now() / 1000));
      await services.guardianVault.put(account, { capability: invite, acceptedAt: services.now(), status: "unverified" });
      setMessage("Capability validated and encrypted. Live account state must match before guardian actions are enabled."); setLink(""); refresh();
    } catch (error) {
      // An invitation and a recovery request travel the same way -- same link
      // shape, same path -- and only their contents tell them apart. Pasted
      // into the wrong box, a recovery request failed as "capability could not
      // be accepted", which describes neither what it is nor where it goes.
      if (await looksLikeRecoveryRequest(link, services)) {
        setMessage("That is a recovery request, not an invitation. It goes in “Review a recovery request” below — and that needs an accepted invitation for the same account first, because a guardian signs with the capability that invitation carries.");
        return;
      }
      setMessage(safeUserMessage(error, "Capability could not be accepted.", "validation"));
    }
  };
  const visibleRecords = guardianVaultRecordsForAccount(records, account);
  const reviewableRecords = reviewableGuardianCapabilitiesForAccount(records, account, Math.floor(services.now() / 1000));

  /**
   * Ask the board about the accounts this wallet already protects. The query set
   * comes from the local vault, so the chain is never asked which accounts this
   * person guards, and a failure here only removes a convenience: the paste and
   * bearer-link paths below stay available.
   */
  const checkForRequests = async () => {
    if (!deployment) return;
    setDiscovery(current => ({ ...current, status: "checking" }));
    try {
      const result = await discoverGuardianRecoveryRequests({
        capabilities: reviewableRecords.map(record => record.capability),
        ...(deployment.recoveryIntentBoard ? { board: deployment.recoveryIntentBoard } : {}),
        ...(deployment.recoveryModule ? { recoveryManager: deployment.recoveryModule } : {}),
        chainId: deployment.chainId,
        logTransport: createRecoveryLogTransport(config, services.publicClients),
        // An independent endpoint's view of the same account. The verified badge
        // sits in front of a signing decision, so one RPC's word is not enough.
        corroborate: async protectedAccount => {
          const client = createAccountGuardianClient({
            config: { ...config, rpcUrl: config.verificationRpcUrl },
            chainId: deployment.chainId,
            account: protectedAccount,
            recoveryManager: deployment.recoveryModule!,
            publicClients: services.publicClients,
            ...(deployment.recoveryValidatorProvisioner ? { recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner } : {}),
            ...(deployment.policyHook ? { policyHook: deployment.policyHook } : {})
          });
          const live = await client.inspectAccount();
          return {
            guardianRoot: live.guardianRoot,
            guardianThreshold: live.guardianThreshold,
            configVersion: live.configVersion,
            validators: live.validators,
            recoveryConfigured: live.recoveryConfigured
          };
        },
        inspect: async protectedAccount => {
          const client = createAccountGuardianClient({
            config, chainId: deployment.chainId, account: protectedAccount,
            recoveryManager: deployment.recoveryModule!, publicClients: services.publicClients,
            ...(deployment.recoveryValidatorProvisioner ? { recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner } : {}),
            ...(deployment.policyHook ? { policyHook: deployment.policyHook } : {})
          });
          const live = await client.inspectAccount();
          return {
            guardianRoot: live.guardianRoot,
            guardianThreshold: live.guardianThreshold,
            configVersion: live.configVersion,
            validators: live.validators,
            recoveryConfigured: live.recoveryConfigured
          };
        },
        now: Math.floor(services.now() / 1000)
      });
      setDiscovery({
        status: "done",
        requests: result.requests,
        rolledBack: result.rolledBack,
        ...(result.unavailable === undefined ? {} : { unavailable: result.unavailable })
      });
    } catch {
      setDiscovery({ status: "done", requests: [], rolledBack: [], unavailable: "Recovery requests could not be read from the network. Paste a request or bearer link instead." });
    }
  };
  const reviewRecovery = async () => {
    try {
      const request = recoveryArtifact.trim().startsWith("{")
        ? parseRecoveryRequest(recoveryArtifact)
        : parseRecoveryRequest(await createEncryptedLinkTransport<RecoveryRequestV1>({ origin: window.location.origin, path: "/guardian" }).receive(recoveryArtifact));
      const now = Math.floor(services.now() / 1000);
      const record = reviewableGuardianCapabilitiesForAccount(records, account, now).find(candidate =>
        candidate.capability.chainId === request.chainId
        && candidate.capability.account.toLowerCase() === request.account.toLowerCase()
      );
      if (!record) throw new Error("This guardian wallet has no accepted capability for that protected account.");
      setApproving({ request, capability: record.capability });
    } catch (error) { setMessage(safeUserMessage(error, "Recovery request could not be reviewed.", "validation")); }
  };
  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Guardian workspace</p><h1>Accounts I protect</h1><p>This private list exists only on this device. The chain cannot enumerate it.</p></header>
    <section className="privacy-banner"><span aria-hidden="true">◌</span><div><strong>Local and encrypted</strong><p>Capabilities use authenticated browser encryption. This reduces casual storage disclosure, but an XSS running on this origin can still use the device key.</p></div></section>
    <section className="section-card"><div className="section-heading"><div><p className="eyebrow">Accept an invitation</p><h2>Invite link or QR payload</h2></div><span className="pill">Bearer secret</span></div>
      <label className="field"><span>Invitation</span><input value={link} onChange={event => setLink(event.target.value)} placeholder="https://wallet.example/guardian#cap=…" /></label>
      <button className="primary" onClick={accept} disabled={!link.trim()}>Review invitation</button>
      <details><summary>Advanced / portable file fallback</summary><p>Paste a versioned JSON capability exported from an independent wallet. It contains only your proof, never the full guardian set.</p></details>
      {message && <p className="toast" role="status">{message}</p>}
    </section>
    {reviewableRecords.length > 0 && <section className="section-card" aria-labelledby="discovered-requests-heading">
      <div className="section-heading"><div><p className="eyebrow">Guardian recovery</p><h2 id="discovered-requests-heading">Requests for accounts you protect</h2></div><span className="pill">{discovery.requests.length}</span></div>
      <p>Checked against the accounts in your local list only. Nothing on chain records who you protect.</p>
      {discovery.rolledBack.length > 0 && <p className="callout warning" role="status"><strong>A published approval was rolled back.</strong> {discovery.rolledBack.length} approval(s) disappeared after a chain reorganisation, so the counts below are lower than what you saw before.</p>}
      {discovery.unavailable && <p className="callout warning" role="status">{discovery.unavailable}</p>}
      {discovery.status === "done" && discovery.requests.length === 0 && !discovery.unavailable && <p className="form-note">No recovery request was found for the accounts you protect.</p>}
      <ul className="wallet-list discovered-request-list">
        {discovery.requests.map(view => <li key={view.key}>
          <article className="section-card discovered-request">
            <div className="section-heading">
              <div><p className="eyebrow">{shorten(view.account)}</p><h3>{view.trust === "verified" ? "Recovery request verified" : "Possible recovery request"}</h3></div>
              <span className={`pill ${view.trust === "verified" ? "included" : "pending"}`}>{view.trust === "verified" ? "Verified against chain" : "Unverified"}</span>
            </div>
            <div className="permission-grid">
              <div><span>Published approvals</span><strong>{view.publishedApprovals} of {view.threshold}</strong></div>
              {view.expiresAt !== undefined && <div><span>Expires</span><strong>{new Date(view.expiresAt * 1000).toLocaleString()}</strong></div>}
            </div>
            {view.trust === "verified"
              ? <p className="form-note">The announced request matches this account's live guardian configuration. Compare the six-digit code with the person recovering it before you approve.</p>
              : <p className="callout warning">{view.issue}</p>}
            {view.alreadyPublishedByMe && <p className="form-note">You have already published an approval for this request.</p>}
            {view.trust === "verified" && view.request && <button className="primary" onClick={() => {
              const record = reviewableRecords.find(candidate => candidate.capability.capabilityId === view.capabilityId);
              if (record) setApproving({ request: view.request!, capability: record.capability, alreadyPublished: view.alreadyPublishedByMe });
            }}>Review request</button>}
          </article>
        </li>)}
      </ul>
      <button className="secondary" disabled={discovery.status === "checking" || !deployment} onClick={() => void checkForRequests()}>
        {discovery.status === "checking" ? "Checking the chain…" : "Check for recovery requests"}
      </button>
    </section>}
    <section className="section-card"><div className="section-heading"><div><p className="eyebrow">Guardian recovery</p><h2>Review a recovery request</h2></div><span className="pill">No gas</span></div><p>Paste the request or bearer link sent by the recovering person. The open guardian wallet must already hold the matching accepted capability.</p>
      {/* This section used to disappear entirely without one, so a guardian who
          had not accepted their invitation yet found nowhere to paste and no
          reason given -- and tried the invitation box instead. */}
      {reviewableRecords.length === 0 && <p className="callout warning"><strong>No accepted invitation for this account yet.</strong> Reviewing a request here needs the capability an invitation carries. If you were never sent one, use <em>Sign without an invitation</em> below instead — it produces the signature, and the person recovering the account supplies the rest.</p>}
      <label className="field"><span>Recovery request or bearer link</span><textarea rows={5} value={recoveryArtifact} disabled={reviewableRecords.length === 0} onChange={event => setRecoveryArtifact(event.target.value)} placeholder='{"format":"loom.recovery-request",…}' /></label><button className="primary" disabled={!recoveryArtifact.trim() || reviewableRecords.length === 0} onClick={() => void reviewRecovery()}>Review recovery request</button></section>
    <SignWithoutInvitation account={account} />

    {issues.length > 0 && <section className="section-card" aria-labelledby="guardian-vault-issues"><div className="section-heading"><div><p className="eyebrow">Local vault maintenance</p><h2 id="guardian-vault-issues">Unreadable records</h2></div><span className="pill failed">{issues.length}</span></div>
      <p>These encrypted records failed authentication or validation. Healthy guardian accounts remain available.</p>
      {issues.map(issue => <div className="guardian-actions" key={String(issue.key)}><span>{issue.message}</span><button className="secondary" onClick={async () => {
        try { await services.guardianVault.remove(issue.key); await refresh(); setMessage("Unreadable local record removed."); }
        catch (error) { setMessage(safeUserMessage(error, "Unreadable record could not be removed.", "storage")); }
      }}>Remove local record</button></div>)}
    </section>}
    {visibleRecords.length === 0 ? <section className="empty-state"><span aria-hidden="true">◇</span><h2>No accepted accounts for this wallet</h2><p>Open an invitation addressed to this guardian wallet. Invitations accepted by another local wallet stay private to that wallet.</p></section> : visibleRecords.map(record => <GuardianAccount key={record.capability.capabilityId} record={record} onFreeze={() => setFreezing(record.capability)} />)}
    {freezing && deployment && <FreezeDialog capability={freezing} deployment={deployment} guardianAccount={account} onClose={() => setFreezing(null)} />}
    {approving && deployment && <RecoveryApprovalDialog {...approving} deployment={deployment} guardianAccount={account} onClose={() => setApproving(null)} />}
  </div>;
}

function GuardianAccount({ record, onFreeze }: { record: GuardianVaultRecord; onFreeze(): void }) {
  const invite: GuardianInviteV1 = record.capability;
  return <article className="section-card guardian-account"><div className="section-heading"><div><p className="eyebrow">{GUARDIAN_ACCOUNT_LABEL}</p><h2>{shorten(invite.account)}</h2></div><span className={`pill ${record.status === "stale" ? "failed" : "included"}`}>{record.status}</span></div>
    <div className="permission-grid"><div><span>Chain</span><strong>{invite.chainId}</strong></div><div><span>Guardian type</span><strong>{invite.guardian.kind === "p256" ? "Dedicated passkey" : invite.guardian.kind.toUpperCase()}</strong></div><div><span>Threshold</span><strong>{invite.threshold} of {invite.guardianCount}</strong></div><div><span>Accepted</span><strong>{new Date(record.acceptedAt).toLocaleDateString()}</strong></div></div>
    <p className="callout warning"><strong>Current epoch only.</strong> This version 1 capability has no standby epoch, so recovery continuity is incomplete until the owner delivers a version 2 capability after scheduling the next guardian set.</p>
    <p className="form-note">Freezing pauses this account's ordinary execution for the contract's emergency window. It moves no funds, approves no recovery, and gives you no spending power.</p>
    <div className="guardian-actions"><button className="danger-button" onClick={onFreeze}>Emergency freeze…</button></div>
  </article>;
}

/**
 * Whether what was pasted is a recovery request rather than an invitation.
 *
 * Only used to explain a failure that already happened, so anything it cannot
 * read is simply not a recovery request: a wrong guess here would replace a
 * real validation error with a misleading redirection.
 */
async function looksLikeRecoveryRequest(
  value: string,
  services: { readonly invitationLinks: { receive(value: string): Promise<unknown> } }
): Promise<boolean> {
  const isRequest = (payload: unknown): boolean =>
    Boolean(payload) && typeof payload === "object" && !Array.isArray(payload)
    && (payload as Record<string, unknown>).format === "loom.recovery-request";
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try { return isRequest(JSON.parse(trimmed)); } catch { return false; }
  }
  try { return isRequest(await services.invitationLinks.receive(trimmed)); } catch { return false; }
}
