import type { AccountRecoveryRequest } from "./accountRecoveryRequests";

/**
 * The recoveries already underway for the account being recovered.
 *
 * Shown as soon as the account is checked, without asking. A reader who has
 * started a recovery before has no way to know that from memory -- the passkey
 * is on a device, the validator is on chain, the request is in a file -- and
 * the cost of guessing wrong is a second publication they pay for and can
 * never propose.
 *
 * Laid out as stacked rows rather than reusing `.wallet-list-item`: that class
 * ellipsizes its `small` to a single nowrap line, which is right for a wallet
 * label and wrong for a sentence explaining why a publication is stuck.
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
      : <div className="recovery-request-list">
        {requests.map(request => <article key={request.id} className="recovery-request">
          <header>
            <strong>{request.title}</strong>
            <span className={request.primary ? "pill pending" : "pill"}>{request.status}</span>
          </header>
          <p className="breakable">{request.detail}</p>

          {request.next.kind === "open-session" && <button
            className={request.primary ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => onOpenSession(sessionIdOf(request))}
          >{request.next.label}</button>}

          {request.next.kind === "request-approvals" && <button
            className="primary" disabled={busy} onClick={onRequestApprovals}
          >{request.next.label}</button>}

          {request.next.kind === "publish-validator" && <button
            className="secondary" disabled={busy} onClick={onPublish}
          >{request.next.label}</button>}

          {/* A request nobody here can move is still worth showing: it is the
              publication the reader would otherwise pay to duplicate. The
              reason is a sentence, so it wraps like one. */}
          {request.next.kind === "blocked" && <p className="form-note">{request.next.reason}</p>}
        </article>)}
      </div>}
  </section>;
}

function sessionIdOf(request: AccountRecoveryRequest): string {
  return request.next.kind === "open-session" ? request.next.sessionId : "";
}
