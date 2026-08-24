import type { ReactNode } from "react";
import type { RecoverySession } from "./recoverySession";
import { GuardianInviteLinks } from "./GuardianInviteLinks";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import { createQrGeometry } from "../../components/qrCode";
import type { RecoveryRequestV1 } from "@loom/sdk/recovery";

/**
 * The self-contained panels of a recovery session screen.
 *
 * Lifted out of a single JSX expression of nearly eight thousand characters,
 * verbatim: the markup here is the markup that was there. Each one is a
 * statement of fact about the session with at most one action attached, which
 * is why these three could move without carrying the session's machinery with
 * them. Whether a panel is shown remains `recoverySessionView`'s decision --
 * these render, they do not choose.
 */

export function ProposalReceipt({ session }: { readonly session: RecoverySession }) {
  return <div className="callout success"><strong>On-chain recovery proposal</strong><p className="breakable">Proposal transaction {session.transactionHash}</p>{session.readyAt && <p>Ready after {new Date(Number(BigInt(session.readyAt) * 1_000n)).toLocaleString()}</p>}{session.expiresAt && <p>Execution expires {new Date(Number(BigInt(session.expiresAt) * 1_000n)).toLocaleString()}</p>}</div>;
}

export function ExecutionReceipt({ session, busy, saveRecoveredWallet, setMessage }: {
  readonly session: RecoverySession;
  readonly busy: boolean;
  readonly saveRecoveredWallet: () => Promise<void>;
  readonly setMessage: (value: string) => void;
}) {
  return <div className="callout success"><strong>Recovery executed</strong><p className="breakable">Execution transaction {session.executionTransactionHash}</p><button className="secondary" disabled={busy} onClick={() => void saveRecoveredWallet().then(() => setMessage("Recovered wallet saved.")).catch(error => setMessage(error instanceof Error ? error.message : "Recovered wallet could not be saved."))}>Save recovered wallet</button></div>;
}

export function ImportResponse({ responseArtifact, setResponseArtifact, busy, importResponse }: {
  readonly responseArtifact: string;
  readonly setResponseArtifact: (value: string) => void;
  readonly busy: boolean;
  readonly importResponse: () => Promise<void>;
}) {
  return <div className="recovery-response-import"><label className="field"><span>Guardian response</span><textarea rows={6} value={responseArtifact} onChange={event => setResponseArtifact(event.target.value)} placeholder='{"format":"loom.recovery-response",…}' /></label><button className="secondary" disabled={busy || !responseArtifact.trim()} onClick={() => void importResponse()}>Verify and add response</button></div>;
}

export function CollectedFromChain({ busy, collectFromChain, boardMessage, published }: {
  readonly busy: boolean;
  readonly collectFromChain: () => Promise<void>;
  readonly boardMessage: string;
  readonly published: readonly { readonly guardianLeaf: string; readonly confirmed: boolean }[];
}) {
  return <div className="callout"><strong>Approvals published on chain</strong><p>Guardians can publish approvals on chain instead of sending them to you. Mix both freely: nothing read here is trusted, and every approval is rechecked against the live guardian root before the proposal is submitted.</p><div className="guardian-actions"><button className="secondary" disabled={busy} onClick={() => void collectFromChain()}>{busy ? "Reading the board…" : "Collect approvals from chain"}</button></div>{boardMessage && <p className="form-note" role="status">{boardMessage}</p>}{published.length > 0 && <ul>{published.map(entry => <li key={entry.guardianLeaf} className="breakable">{entry.guardianLeaf.slice(0, 14)}… · {entry.confirmed ? "confirmed" : "recent, may still reorganise"}</li>)}</ul>}</div>;
}

/**
 * A step anyone may submit, which this wallet is merely paying for.
 *
 * Proposing a recovery and executing one are the same shape: a heading, what
 * the step does, a Loom wallet that pays, and an external wallet that can do
 * it instead. They were written out twice, so a correction to one -- and there
 * were several -- reached only half of them.
 *
 * The wording matters and is kept: neither step grants the payer anything.
 * The wallet being recovered is the one wallet that cannot pay, because its
 * passkey may be the thing that is lost.
 */
export function PaidStep({ title, children, busy, busyLabel, primaryLabel, onPrimary, onSecondary, canPay, noPayerNote }: {
  readonly title: string;
  readonly children: ReactNode;
  readonly busy: boolean;
  readonly busyLabel: string;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly onSecondary: () => void;
  readonly canPay: boolean;
  readonly noPayerNote: ReactNode;
}) {
  return <div className="callout warning">
    <strong>{title}</strong>
    <p>{children}</p>
    <div className="guardian-actions">
      <button className="primary" disabled={busy || !canPay} onClick={onPrimary}>{busy ? busyLabel : primaryLabel}</button>
      <button className="secondary" disabled={busy} onClick={onSecondary}>Use external browser wallet</button>
    </div>
    {!canPay && <p className="form-note">{noPayerNote}</p>}
  </div>;
}

/**
 * Getting the request into the guardians' hands.
 *
 * Two routes, and the order is deliberate. Announcing costs one transaction
 * and makes the recovery public now rather than when it is proposed; handing
 * the request over privately costs nothing and reveals nothing, but every
 * guardian has to hear it from you. Neither grants anyone authority: the
 * request carries none, and every response is checked against live state.
 */
export function SendToGuardians(props: {
  readonly session: RecoverySession;
  readonly busy: boolean;
  readonly announced: string;
  readonly announceMessage: string;
  readonly announcePayers: readonly { readonly id: string; readonly label: string; readonly account: string }[];
  readonly announcePayer: { readonly id: string } | undefined;
  readonly setAnnouncePayerId: (value: string) => void;
  readonly announceWithLoomWallet: () => Promise<void>;
  readonly announce: () => Promise<void>;
  readonly copyAnnouncement: () => Promise<void>;
  readonly copyRequest: () => Promise<void>;
  readonly copyEncryptedLink: () => Promise<void>;
  readonly showShareQr: () => Promise<void>;
  readonly download: () => void;
  readonly shareLink: string;
  readonly shortAddress: (value: string) => string;
}) {
  const {
    session, busy, announced, announceMessage, announcePayers, announcePayer, setAnnouncePayerId,
    announceWithLoomWallet, announce, copyAnnouncement, copyRequest, copyEncryptedLink, showShareQr,
    download, shareLink, shortAddress
  } = props;
  return <div className="callout"><strong>Send this request to your guardians.</strong><p>Each guardian signs on their own device and sends a response back. The request grants nothing by itself: {session.request.guardianThreshold} approvals are required, and each is checked against live state.</p><p className="form-note">Worth paying for only when guardians already hold invitations and you cannot reach them. Sending invitations now? Put the request in the same message — free, and just as fast.</p><div className="guardian-actions"><button className="secondary" disabled={busy || Boolean(announced) || !announcePayer} onClick={() => void announceWithLoomWallet()}>{announced ? "Announced" : busy ? "Announcing…" : "Announce & pay with Loom wallet"}</button><button className="secondary" disabled={busy || Boolean(announced)} onClick={() => void announce()}>Use external browser wallet</button><button className="secondary" disabled={busy} onClick={() => void copyAnnouncement()}>Copy exact transaction</button></div>{announcePayers.length > 0 ? <label className="field"><span>Pay for the announcement with</span><select value={announcePayer?.id ?? ""} disabled={busy || Boolean(announced)} onChange={event => setAnnouncePayerId(event.target.value)}>{announcePayers.map(payer => <option key={payer.id} value={payer.id}>{payer.label} · {shortAddress(payer.account)}</option>)}</select></label> : <p className="form-note">No other saved wallet on this chain can pay, so use an external wallet or send the copied transaction yourself. The wallet being recovered cannot pay for its own announcement.</p>}{announceMessage && <p className="callout" role="status">{announceMessage}</p>}{announced && <p className="callout success breakable">Announced: {announced}</p>}<details><summary>Send the request yourself instead</summary><p className="form-note">Announcing costs one transaction and makes this recovery public now instead of at proposal. Handing it over privately costs nothing and reveals nothing, but you must reach every guardian yourself.</p><div className="guardian-actions"><button className="secondary" onClick={() => void copyRequest()}>Copy request</button><button className="secondary" onClick={() => void copyEncryptedLink()}>Copy bearer link</button><button className="secondary" onClick={() => void showShareQr()}>{shareLink ? "Regenerate QR" : "Show QR"}</button><button className="secondary" onClick={download}>Export file</button></div>{shareLink && <ShareQr value={shareLink} />}</details><GuardianInviteLinks
          account={session.request.account}
          chainId={session.request.chainId}
          requestLink={async () => (await createEncryptedLinkTransport<RecoveryRequestV1>({ origin: window.location.origin }).deliver(session.request)).value}
        /></div>;
}

/**
 * The recovery request as a QR, encoded here rather than by any service.
 *
 * Falls back to the text when the value will not fit a code, because a link a
 * guardian can copy beats a blank square.
 */
function ShareQr({ value }: { readonly value: string }) {
  const geometry = createQrGeometry(value);
  if (!geometry) return <p className="breakable form-note">{value}</p>;
  return <div className="recovery-share-qr">
    <svg viewBox={`0 0 ${geometry.size} ${geometry.size}`} width="220" height="220" role="img"
      aria-label="Recovery request bearer link as a QR code">
      <rect width={geometry.size} height={geometry.size} fill="#ffffff" />
      <path d={geometry.path} fill="#000000" />
    </svg>
    <p className="form-note">Scanning this opens the request on the guardian&apos;s device.</p>
  </div>;
}
