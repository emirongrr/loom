import type { ReactNode } from "react";
import type { AccountProtection } from "../features/security/accountProtection";

/**
 * Whether the account can be recovered, and anything happening to it.
 *
 * There were two cards saying this: a posture summary and, below it, a panel
 * that repeated the same fact in the chain's own words. Two answers to one
 * question is worse than either alone, because a reader who notices the
 * repetition starts wondering which one to believe.
 *
 * So the shield leads and the exceptions follow it, in one place. Colour is
 * never the only signal: the mark carries a label, and every row states its
 * meaning in words beside it.
 */
export function SecurityStatus({ protection, delayLabel = "3-day recovery delay", guardians, onAddGuardians, onReviewRecovery, children }: {
  readonly protection: AccountProtection;
  readonly delayLabel?: string;
  /** Shown beside the headline when the account has a quorum. */
  readonly guardians?: string;
  readonly onAddGuardians?: () => void;
  readonly onReviewRecovery?: () => void;
  /** Diagnostics, kept available without leading. */
  readonly children?: ReactNode;
}) {
  const [headline, ...exceptions] = protection.signals;
  return <article className={`posture ${protection.guarded ? "secure" : "warning"}`}>
    <div className={protection.guarded ? "posture-mark" : "posture-mark unguarded"} aria-hidden="true">
      <ShieldMark guarded={protection.guarded} />
    </div>
    <div className="posture-body">
      <p className="eyebrow">Security posture</p>
      <h2>{headline?.title ?? "Recovery not configured"}</h2>
      <p>{protection.guarded && guardians ? `${guardians} · ${delayLabel}` : headline?.detail}</p>

      {exceptions.map(signal => <div key={signal.id} className={`protection-row ${signal.tone}`}>
        <span className="protection-mark" aria-hidden="true">{signal.tone === "urgent" ? "!" : "◷"}</span>
        <div><strong>{signal.title}</strong><p>{signal.detail}</p></div>
        {signal.action === "review-recovery" && onReviewRecovery
          && <button className="primary" onClick={onReviewRecovery}>Review it</button>}
      </div>)}

      {!protection.guarded && onAddGuardians && <div className="guardian-actions">
        <button className="secondary" onClick={onAddGuardians}>Add guardians</button>
      </div>}
      {children}
    </div>
  </article>;
}

/**
 * Drawn rather than written, because this is the one thing an owner should be
 * able to read without reading. It carries its own label for anyone who cannot
 * see it, and the words beside it never depend on the colour.
 */
function ShieldMark({ guarded }: { readonly guarded: boolean }) {
  return <svg viewBox="0 0 24 24" width="26" height="26" role="img"
    aria-label={guarded ? "Protected" : "Not protected"} focusable="false">
    <path d="M12 2.5 20 5.5v6.2c0 4.6-3.2 8.4-8 9.8-4.8-1.4-8-5.2-8-9.8V5.5z"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    {guarded
      ? <path d="M8.2 12.2 11 15l4.8-5.2" fill="none" stroke="currentColor" strokeWidth="1.9"
        strokeLinecap="round" strokeLinejoin="round" />
      : <path d="M12 7.6v5.2M12 16.1v.1" fill="none" stroke="currentColor" strokeWidth="1.9"
        strokeLinecap="round" />}
  </svg>;
}
