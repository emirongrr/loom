import { useEffect, useState } from "react";
import type { CancelRequestV1, GuardianInviteV1, RecoveryRequestV1 } from "@loom/sdk/recovery";
import { parseCancelRequest, parseGuardianInvite, parseRecoveryRequest } from "@loom/sdk/recovery";
import { receiveGuardianInvite } from "../../transports/invitations";
import { useAppServices } from "../../app/AppServices";
import { FreezeDialog } from "./FreezeDialog";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import type { GuardianVaultIssue, GuardianVaultRecord } from "../../storage/guardianVault";
import { GUARDIAN_ACCOUNT_LABEL } from "../security/guardianInvitation";
import type { AccountHandle } from "../../types";
import { safeUserMessage } from "../../domain/errors/appError";
import { guardianVaultRecordsForAccount, reviewableGuardianCapabilitiesForAccount } from "../../storage/guardianVaultScope";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import { RecoveryApprovalDialog } from "./RecoveryApprovalDialog";
import { CancellationApprovalDialog } from "./CancellationApprovalDialog";
import { Callout } from "../../components/Callout";
import { describePendingCancellation, distinctProtectedAccounts, protectedAccountsKey, type PendingCancellationView } from "./pendingCancellations";
import { useNetwork } from "../../config/NetworkContext";
import { createRecoveryLogTransport } from "../../transports/recoveryLogs";
import { createAccountGuardianClient } from "../security/guardianClient";
import { discoverGuardianRecoveryRequests } from "./guardianDiscovery";
import { capabilityStanding, describeStanding, type CapabilityStanding } from "./capabilityStanding";
import { useClipboard } from "../../components/useClipboard";
import type { DiscoveredRequestView } from "./discoveredRequests";
import { mediumAddress, shortAddress } from "../../components/address.ts";

export function GuardianWorkspace({ account, inboundLink = "", embedded = false }: {
  readonly account: AccountHandle;
  readonly inboundLink?: string;
  /** Rendered inside another page, which already carries the heading. */
  readonly embedded?: boolean;
}) {
  const services = useAppServices();
  const [records, setRecords] = useState<readonly GuardianVaultRecord[]>([]);
  const [issues, setIssues] = useState<readonly GuardianVaultIssue[]>([]);
  const [link, setLink] = useState("");
  const [arrived, setArrived] = useState(false);
  const [message, setMessage] = useState("");
  /** Read from each protected account, never stored: a written-down status is
      exactly what goes stale without anyone noticing. */
  const [standings, setStandings] = useState<Readonly<Record<string, CapabilityStanding>>>({});
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [freezing, setFreezing] = useState<GuardianInviteV1 | null>(null);
  const [recoveryArtifact, setRecoveryArtifact] = useState("");
  const [cancelArtifact, setCancelArtifact] = useState("");
  const [cancelMessage, setCancelMessage] = useState("");
  const [cancelling, setCancelling] = useState<{ readonly request: CancelRequestV1; readonly capability: GuardianInviteV1 } | null>(null);
  const [stoppable, setStoppable] = useState<{
    readonly status: "idle" | "reading" | "done";
    readonly entries: readonly PendingCancellationView[];
    readonly unavailable?: string;
  }>({ status: "idle", entries: [] });
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
          setArrived(true);
          return;
        }
        const request = parseRecoveryRequest(payload);
        const matchesOpenWallet = reviewableGuardianCapabilitiesForAccount(records, account).some(record =>
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
      setMessage("Invitation accepted and encrypted on this device. Its standing against the account is read from the chain and shown on the card."); setLink(""); refresh();
    } catch (error) {
      // An invitation and a recovery request travel the same way -- same link
      // shape, same path -- and only their contents tell them apart. Pasted
      // into the wrong box, a recovery request failed as "capability could not
      // be accepted", which describes neither what it is nor where it goes.
      if (await looksLikeRecoveryRequest(link, services)) {
        setMessage("That is a recovery request, not an invitation. Accept the invitation for that account first — you sign with the proof it carries — and the request will appear below.");
        return;
      }
      setMessage(safeUserMessage(error, "Capability could not be accepted.", "validation"));
    }
  };
  const visibleRecords = guardianVaultRecordsForAccount(records, account);
  const reviewableRecords = reviewableGuardianCapabilitiesForAccount(records, account);
  const protectedAccountKey = protectedAccountsKey(reviewableRecords);

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
      const record = reviewableGuardianCapabilitiesForAccount(records, account).find(candidate =>
        candidate.capability.chainId === request.chainId
        && candidate.capability.account.toLowerCase() === request.account.toLowerCase()
      );
      if (!record) throw new Error("This guardian wallet has no accepted capability for that protected account.");
      setApproving({ request, capability: record.capability });
    } catch (error) { setMessage(safeUserMessage(error, "Recovery request could not be reviewed.", "validation")); }
  };
  /**
   * Read a cancellation request the same way a recovery request is read, and
   * refuse it just as readily. Kept separate from `reviewRecovery` because the
   * two ask opposite questions of the guardian, and one function answering
   * both would be one edit away from answering the wrong one.
   */
  /**
   * Look for recoveries pending against the accounts this guardian protects.
   *
   * Reads only accounts already in the local list, one ordinary state read
   * each. Nothing on chain records who protects whom, and this must not become
   * the thing that does.
   */
  useEffect(() => {
    // Whether a capability still counts is read here rather than alongside
    // recovery discovery: that path needs an intent board and a log-serving
    // endpoint, and when either is missing it returns before reading any
    // account at all -- leaving the badge saying "Checking…" for good. This
    // needs only the account's own state, which is the same read this effect
    // already makes.
    const unread = (detail: string) => Object.fromEntries(reviewableRecords.map(record =>
      [record.capability.capabilityId, { kind: "unreadable" as const, detail }]));
    if (!deployment?.recoveryModule || protectedAccountKey.length === 0) {
      if (reviewableRecords.length > 0) {
        setStandings(unread("This deployment publishes no recovery manager to ask."));
      }
      return;
    }
    const manager = deployment.recoveryModule;
    const chainId = deployment.chainId;
    let cancelled = false;
    setStoppable({ status: "reading", entries: [] });
    void (async () => {
      try {
        const now = Math.floor(services.now() / 1000);
        const found: PendingCancellationView[] = [];
        const readStandings: Record<string, CapabilityStanding> = {};
        let unreadable = 0;
        for (const capability of distinctProtectedAccounts(reviewableRecords, chainId)) {
          try {
            const client = createAccountGuardianClient({
              config, chainId, account: capability.account, recoveryManager: manager, publicClients: services.publicClients
            });
            const [live, pending] = await Promise.all([client.inspectAccount(), client.readPendingRecovery()]);
            for (const record of reviewableRecords) {
              if (record.capability.account.toLowerCase() !== capability.account.toLowerCase()) continue;
              readStandings[record.capability.capabilityId] = capabilityStanding({
                capability: record.capability, live
              });
            }
            const view = describePendingCancellation({ capability, recoveryManager: manager, live, pending, nowSeconds: now });
            if (view) found.push(view);
          } catch {
            // One account that cannot be read -- not deployed yet, or an
            // endpoint that failed on this call -- must not hide the pending
            // recoveries of every other account this guardian protects.
            unreadable += 1;
          }
        }
        if (!cancelled) {
          // A capability whose account could not be read keeps no verdict at
          // all rather than inheriting one from an account that was.
          setStandings({ ...unread("The account could not be read from this endpoint."), ...readStandings });
          setStoppable({
            status: "done",
            entries: Object.freeze(found),
            ...(unreadable > 0
              ? { unavailable: `${unreadable} of the accounts you protect could not be read, so this list may be incomplete.` }
              : {})
          });
        }
      } catch {
        // Unreadable is not "nothing pending". The manual path stays open.
        if (!cancelled) {
          setStandings(unread("The account could not be read from this endpoint."));
          setStoppable({ status: "done", entries: [], unavailable: "Pending recoveries could not be read from the network. Paste a cancellation request instead." });
        }
      }
    })();
    return () => { cancelled = true; };
    // Keyed by which accounts are protected, not by the array holding them.
    // `reviewableRecords` is rebuilt on every render, so depending on it made
    // this effect re-run on every render -- and its first act is to set the
    // reading state, which causes another render. The list sat on "Reading the
    // chain" forever, looking like a chain problem rather than a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, deployment, protectedAccountKey, services]);

  const reviewCancellation = async () => {
    setCancelMessage("");
    try {
      const request = cancelArtifact.trim().startsWith("{")
        ? parseCancelRequest(cancelArtifact)
        : parseCancelRequest(await createEncryptedLinkTransport<CancelRequestV1>({ origin: window.location.origin, path: "/guardian" }).receive(cancelArtifact));
      const record = reviewableGuardianCapabilitiesForAccount(records, account).find(candidate =>
        candidate.capability.chainId === request.chainId
        && candidate.capability.account.toLowerCase() === request.account.toLowerCase()
      );
      if (!record) throw new Error("This guardian wallet has no accepted capability for that protected account.");
      setCancelling({ request, capability: record.capability });
    } catch (error) { setCancelMessage(safeUserMessage(error, "Cancellation request could not be reviewed.", "validation")); }
  };
  return <div className="page-stack">{!embedded && <header className="page-title"><p className="eyebrow">Guardian workspace</p><h1>Accounts I protect</h1><p>This private list exists only on this device. The chain cannot enumerate it.</p></header>}
    <section className="section-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Someone asked for your help</p>
          <h2>Accept an invitation</h2>
        </div>
        <span className="pill">Treat like a password</span>
      </div>
      {/* Arriving by link used to fill the box and say nothing. Someone who
          followed a friend's message found a filled field and no idea what it
          was or what to press. */}
      {arrived && <Callout tone="warning" title="You were invited to help protect an account." live>
        <p>
          The invitation is in the field below. Reviewing it shows whose account it is and what you would be agreeing
          to. Accepting gives you no power to spend their money — only to help them recover the account if they lose
          access.
        </p>
      </Callout>}
      <label className="field">
        <span>Invitation link</span>
        <input value={link} onChange={event => setLink(event.target.value)} placeholder="https://wallet.example/guardian#cap=…" />
      </label>
      <button className="primary" onClick={accept} disabled={!link.trim()}>Review invitation</button>
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
              <div><p className="eyebrow">{shortAddress(view.account)}</p><h3>{view.trust === "verified" ? "Recovery request verified" : "Possible recovery request"}</h3></div>
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
    <section className="section-card">
      <div className="section-heading">
        <div><p className="eyebrow">Guardian recovery</p><h2>Review a request</h2></div>
        <span className="pill">No gas</span>
      </div>
      {/* Without an accepted invitation there is nothing to sign with, and this
          section used to vanish entirely -- so a guardian who had not accepted
          theirs found nowhere to act and no reason given, and tried the
          invitation box instead. */}
      {reviewableRecords.length === 0
        ? <p className="callout warning">
          <strong>Accept your invitation first.</strong> You sign with the proof it carries, so nothing can be
          reviewed until it is accepted above.
        </p>
        : <p className="form-note">
          Requests for accounts you protect appear above as soon as they are announced. Compare the six-digit code
          with the person recovering before you approve.
        </p>}
      {/* Announcing costs a transaction, so many requests are handed over
          privately and never appear on chain at all. Removing this would close
          the route that costs nothing. */}
      <details>
        <summary>It was sent to me directly</summary>
        <p className="form-note">Paste the request or link they sent you.</p>
        <label className="field">
          <span>Request</span>
          <textarea rows={4} value={recoveryArtifact} disabled={reviewableRecords.length === 0} onChange={event => setRecoveryArtifact(event.target.value)} placeholder="Paste the request" />
        </label>
        <button className="secondary" disabled={!recoveryArtifact.trim() || reviewableRecords.length === 0} onClick={() => void reviewRecovery()}>Review pasted request</button>
      </details>
    </section>

    {/* Red only when there is something to stop. A card that warns every day
        about a decision nobody is being asked to make teaches people to stop
        reading it, and the warning is worth reading on the day it applies. */}
    <section
      className={stoppable.entries.length > 0 ? "section-card cancellation-card" : "section-card"}
      aria-labelledby="stop-recovery-heading"
    >
      <div className="section-heading">
        <div><p className="eyebrow">The opposite request</p><h2 id="stop-recovery-heading">Stop a recovery</h2></div>
        <span className={stoppable.entries.length > 0 ? "pill failed" : "pill"}>No gas</span>
      </div>

      {stoppable.entries.length > 0 && <div className="removal-confirmation">
        <div className="removal-warning">
          <span aria-hidden="true">!</span>
          <div>
            <strong>Check which way you are signing.</strong>
            <p>
              This takes a recovery away. If it is genuine, the owner is stranded — the failure guardians exist to
              prevent. Confirm with them over a channel you trust first.
            </p>
          </div>
        </div>
      </div>}

      {reviewableRecords.length === 0 && <p className="callout warning">
        <strong>Nothing can be signed here yet.</strong> A cancellation carries the same proof an approval does, so
        an invitation has to be accepted first.
      </p>}

      {stoppable.status === "reading" && <p className="form-note">Checking the accounts you protect…</p>}
      {stoppable.unavailable && <p className="callout warning" role="status">{stoppable.unavailable}</p>}
      {stoppable.status === "done" && stoppable.entries.length === 0 && !stoppable.unavailable && reviewableRecords.length > 0
        && <p className="form-note">No recovery is pending against the accounts you protect, so there is nothing to stop.</p>}

      {stoppable.entries.length > 0 && <ul className="wallet-list">
        {stoppable.entries.map(entry => <li key={entry.request.recoveryId} className="wallet-list-item stoppable-recovery">
          <div>
            <strong className="breakable">{entry.account}</strong>
            <p className="form-note">
              {entry.phase === "expired"
                ? "Expired, but still holding the recovery slot."
                : entry.phase === "executable"
                  ? "Executable now — control moves as soon as anyone completes it."
                  : `Becomes executable ${new Date(Number(entry.readyAt) * 1000).toLocaleString()}.`}
              {" "}Control would move to {mediumAddress(entry.newValidator)}.
              Stopping it takes {entry.guardianThreshold} guardian{entry.guardianThreshold === 1 ? "" : "s"},
              or the account plus {Math.max(1, entry.guardianThreshold - 1)}.
            </p>
          </div>
          <button className="danger-button" onClick={() => setCancelling({ request: entry.request, capability: entry.capability })}>
            Review stopping it
          </button>
        </li>)}
      </ul>}

      <details>
        <summary>A cancellation was sent to me directly</summary>
        <p className="form-note">Paste the request or link they sent you.</p>
        <label className="field">
          <span>Request</span>
          <textarea
            rows={4}
            value={cancelArtifact}
            disabled={reviewableRecords.length === 0}
            onChange={event => setCancelArtifact(event.target.value)}
            placeholder="Paste the cancellation"
          />
        </label>
        <button
          className="danger-button"
          disabled={!cancelArtifact.trim() || reviewableRecords.length === 0}
          onClick={() => void reviewCancellation()}
        >Review pasted cancellation</button>
      </details>
      {cancelMessage && <p className="callout" role="status">{cancelMessage}</p>}
    </section>
    {issues.length > 0 && <section className="section-card" aria-labelledby="guardian-vault-issues"><div className="section-heading"><div><p className="eyebrow">Local vault maintenance</p><h2 id="guardian-vault-issues">Unreadable records</h2></div><span className="pill failed">{issues.length}</span></div>
      <p>These encrypted records failed authentication or validation. Healthy guardian accounts remain available.</p>
      {issues.map(issue => <div className="guardian-actions" key={String(issue.key)}><span>{issue.message}</span><button className="secondary" onClick={async () => {
        try { await services.guardianVault.remove(issue.key); await refresh(); setMessage("Unreadable local record removed."); }
        catch (error) { setMessage(safeUserMessage(error, "Unreadable record could not be removed.", "storage")); }
      }}>Remove local record</button></div>)}
    </section>}
    {visibleRecords.length === 0 ? <section className="empty-state"><span aria-hidden="true">◇</span><h2>No accepted accounts for this wallet</h2><p>Open an invitation addressed to this guardian wallet. Invitations accepted by another local wallet stay private to that wallet.</p></section> : visibleRecords.map(record => <GuardianAccount
      key={record.capability.capabilityId}
      record={record}
      standing={standings[record.capability.capabilityId]}
      onFreeze={() => setFreezing(record.capability)}
    />)}
    {freezing && deployment && <FreezeDialog capability={freezing} deployment={deployment} guardianAccount={account} onClose={() => setFreezing(null)} />}
    {approving && deployment && <RecoveryApprovalDialog {...approving} deployment={deployment} guardianAccount={account} onClose={() => setApproving(null)} />}
    {cancelling && deployment && <CancellationApprovalDialog {...cancelling} deployment={deployment} guardianAccount={account} onClose={() => { setCancelling(null); setCancelArtifact(""); }} />}
  </div>;
}

function GuardianAccount({ record, standing, onFreeze }: {
  record: GuardianVaultRecord;
  /** Absent until the account has been read; absence is not a verdict. */
  standing: CapabilityStanding | undefined;
  onFreeze(): void;
}) {
  const invite: GuardianInviteV1 = record.capability;
  // The stored status only ever said "unverified": nothing wrote any other
  // value, so the badge told the guardian the same thing forever. What they
  // need to know is whether this capability still counts, which only the
  // account can say.
  const described = standing ? describeStanding(standing) : null;
  const clipboard = useClipboard();
  return <article className="section-card guardian-account"><div className="section-heading"><div>
      <p className="eyebrow">{GUARDIAN_ACCOUNT_LABEL}</p>
      {/* Shortened to be read, copied in full: the address is what a guardian
          needs to check the account anywhere else, and retyping 40 characters
          from a truncated one is not an option. */}
      <h2>
        <button
          className="address-copy"
          aria-label={`Copy the full address of the account ${shortAddress(invite.account)}`}
          onClick={() => void clipboard.copy(invite.account, { what: "Account address" })}
        >
          <span>{shortAddress(invite.account)}</span>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
            <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="M5 15V6a1 1 0 0 1 1-1h9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      </h2>
    </div>
      <span className={`pill ${described === null ? "pending" : described.tone === "good" ? "included" : "failed"}`}>
        {described?.label ?? "Checking…"}
      </span></div>
    {described && <p className={described.tone === "good" ? "form-note" : "callout warning"}>{described.detail}</p>}
    {/* What a guardian acts on: how many approvals this account needs, and
        when they took this on. The chain is the one they are already on, and
        the guardian type describes their own key rather than the account --
        neither changes anything they would do here. */}
    <div className="permission-grid"><div><span>Threshold</span><strong>{invite.threshold} of {invite.guardianCount}</strong></div><div><span>Accepted</span><strong>{new Date(record.acceptedAt).toLocaleDateString()}</strong></div></div>
    <p className="form-note">Freezing pauses this account's ordinary execution for the contract's emergency window. It moves no funds, approves no recovery, and gives you no spending power.</p>
    {clipboard.message && <p className={clipboard.failed ? "callout warning" : "form-note"}>{clipboard.message}</p>}
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
