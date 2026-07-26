import { useEffect, useRef } from "react";
import type { TransactionReviewModel } from "../types";

export function TransactionReview({ review, open, busy, onCancel, onConfirm }: { review: TransactionReviewModel; open: boolean; busy?: boolean; onCancel(): void; onConfirm(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="review-sheet" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <div className="sheet-handle" />
    <p className="eyebrow">Review before authentication</p>
    <h2>{review.title}</h2>
    <div className="review-summary">
      <ReviewRow label="Account" value={`${review.account.slice(0, 8)}…${review.account.slice(-6)}`} />
      <ReviewRow label="Network" value={review.network} />
      {review.destination && <ReviewRow label="Destination" value={`${review.destination.slice(0, 8)}…${review.destination.slice(-6)}`} />}
      <ReviewRow label="Gas payer" value={review.gasPayer} />
      <ReviewRow label="Route" value={review.route} />
      {review.estimatedFee && <ReviewRow label="Estimated fee" value={review.estimatedFee} />}
    </div>
    <ReviewList title="Exact effects" items={review.effects} />
    {review.securityConsequences.length > 0 && <ReviewList title="Security consequences" items={review.securityConsequences} />}
    <div className={`simulation ${review.simulation.status}`}><strong>Simulation</strong><span>{review.simulation.status === "not-run" ? "Not run" : review.simulation.summary}</span></div>
    {review.warnings.map(warning => <p className="callout warning" key={warning}>{warning}</p>)}
    <div className="sheet-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy || review.simulation.status === "failed"} onClick={onConfirm}>{busy ? "Authenticating…" : "Confirm with passkey"}</button></div>
  </dialog>;
}

function ReviewRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function ReviewList({ title, items }: { title: string; items: readonly string[] }) { return <section><h3>{title}</h3><ul className="effect-list">{items.map(item => <li key={item}>{item}</li>)}</ul></section>; }
