export function SecurityStatus({ guardians, threshold, frozen, pendingRecovery }: { guardians: number; threshold: number; frozen: boolean; pendingRecovery: boolean }) {
  const protectedAccount = guardians > 0 && threshold > 0;
  return <article className={`posture ${protectedAccount ? "secure" : "warning"}`}>
    <div className="posture-mark" aria-hidden="true">{protectedAccount ? "✓" : "!"}</div>
    <div>
      <p className="eyebrow">Security posture</p>
      <h2>{frozen ? "Account frozen" : pendingRecovery ? "Recovery in progress" : protectedAccount ? "Recovery protected" : "Finish protection"}</h2>
      <p>{protectedAccount ? `${threshold}-of-${guardians} guardians · 3-day recovery delay` : "Add independent guardians so a lost passkey does not mean a lost account."}</p>
    </div>
  </article>;
}
