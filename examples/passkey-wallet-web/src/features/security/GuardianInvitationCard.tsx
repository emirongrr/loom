import { useMemo } from "react";
import { createGuardianInviteQr } from "./guardianInviteQr";

export interface GuardianInvitationView {
  readonly guardianId: string;
  readonly guardianLabel: string;
  readonly link: string;
  readonly expiresAt: number;
}

export function GuardianInvitationCard({ invitation, onCopy, onClose }: {
  readonly invitation: GuardianInvitationView;
  readonly onCopy: () => void;
  readonly onClose: () => void;
}) {
  const qr = useMemo(() => createGuardianInviteQr(invitation.link), [invitation.link]);
  return <div className="guardian-invite-card" role="status">
    <div className="section-heading">
      <div><p className="eyebrow">Private guardian invite</p><h3>{invitation.guardianLabel}</h3></div>
      <span className="pill included">Active set</span>
    </div>
    <p>Open this link on the guardian's device or scan the QR there. The guardian must review and accept it before this account appears under Accounts I protect.</p>
    {qr ? <svg className="guardian-invite-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`Guardian invitation QR for ${invitation.guardianLabel}`}>
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#111" />
    </svg> : <p className="callout warning">This invite is too large for one QR code. Use the encrypted link instead.</p>}
    <label className="field"><span>Encrypted invite link</span>
      <textarea readOnly rows={3} value={invitation.link} onFocus={event => event.currentTarget.select()} />
    </label>
    <p className="form-note">Expires {new Date(invitation.expiresAt * 1_000).toLocaleString()}. The capability is encrypted in the URL fragment and is not sent to the web server.</p>
    <div className="guardian-actions">
      <button className="secondary" onClick={onClose}>Close</button>
      <button className="primary" onClick={onCopy}>Copy invite link</button>
    </div>
  </div>;
}
