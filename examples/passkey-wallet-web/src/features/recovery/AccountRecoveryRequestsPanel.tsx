import type { AccountRecoveryRequest } from "./accountRecoveryRequests";

/**
 * The recoveries already underway for the account being recovered.
 *
 * Shown as soon as the account is checked, without asking. A reader who has
 * started a recovery before has no way to know that from memory -- the passkey
 * is on a device, the validator is on chain, the request is in a file -- and
 * the cost of guessing wrong is a second publication they pay for and can
 * never propose.
 */
export function AccountRecoveryRequestsPanel({ requests, busy, onOpenSession, onRequestApprovals, onPublish }: {
  readonly requests: readonly AccountRecoveryRequest[];
  readonly busy?: boolean;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onRequestApprovals: () => void;
  readonly onPublish: () => void;
}) {
  return <section className="saved-wallets" aria-labelledby="account-recoveries-title">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Already underway for this account</p>
        <h2 id="account-recoveries-title">Recovery requests</h2>
      </div>
      <span className="pill">{requests.length}</span>
    </div>

    {requests.length === 0
      ? <div className="empty-state compact">
        <h3>Nothing in progress</h3>
        <p>No recovery request, published recovery passkey, or on-chain proposal was found for this account.</p>
      </div>
      : <div className="wallet-list">
        {requests.map(request => <div key={request.id} className="wallet-list-item recovery-request-item">
          <span className="identicon" />
          <span>
            <strong>{request.title}</strong>
            <small>{request.status}</small>
            <small className="breakable">{request.detail}</small>
          </span>
          {request.next.kind === "open-session" && <button
            className={request.primary ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => onOpenSession(request.next.kind === "open-session" ? request.next.sessionId : "")}
          >{request.next.label}</button>}
          {request.next.kind === "request-approvals" && <button
            className="primary" disabled={busy} onClick={onRequestApprovals}
          >{request.next.label}</button>}
          {request.next.kind === "publish-validator" && <button
            className="secondary" disabled={busy} onClick={onPublish}
          >{request.next.label}</button>}
          {/* A request nobody here can move is still worth showing: it is the
              publication the reader would otherwise pay to duplicate. The
              reason is a sentence, not a status chip -- `.pill` capitalises
              every word, which turned it into a headline. */}
          {request.next.kind === "blocked" && <small className="form-note">{request.next.reason}</small>}
        </div>)}
      </div>}
  </section>;
}
