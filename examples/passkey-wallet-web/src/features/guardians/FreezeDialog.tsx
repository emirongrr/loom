import { useEffect, useState } from "react";
import type { Hex } from "@loom/core";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { useNetwork } from "../../config/NetworkContext";
import { useNotifications } from "../../notifications/NotificationsContext";
import { shorten } from "../../components/AccountHeader";
import { prepareGuardianFreeze, readFreezeState, type FreezePreparation } from "./freeze";
import type { WalletDeployment } from "../onboarding/accountLifecycle";

type Step =
  | { status: "checking" }
  | { status: "unavailable"; message: string }
  | { status: "frozen"; until: bigint }
  | { status: "signing" }
  | { status: "verifying" }
  | { status: "ready"; prepared: FreezePreparation };

export function FreezeDialog({ capability, deployment, onClose }: {
  capability: GuardianInviteV1;
  deployment: WalletDeployment;
  onClose(): void;
}) {
  const { config } = useNetwork();
  const notifications = useNotifications();
  const [step, setStep] = useState<Step>({ status: "checking" });
  const [signature, setSignature] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    readFreezeState({ config, deployment, capability })
      .then(state => {
        if (!active) return;
        if (state.active) setStep({ status: "frozen", until: state.frozenUntil });
        else if (!state.recoveryConfigured) setStep({ status: "unavailable", message: "This account has no active guardian recovery, so it cannot be frozen." });
        else setStep({ status: "signing" });
      })
      .catch(issue => { if (active) setStep({ status: "unavailable", message: issue instanceof Error ? issue.message : "Account state could not be read." }); });
    return () => { active = false; };
  }, [config, deployment, capability]);

  const verify = async () => {
    setError("");
    const trimmed = signature.trim();
    if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) { setError("Paste the guardian signature as hex."); return; }
    setStep({ status: "verifying" });
    try {
      const prepared = await prepareGuardianFreeze({ config, deployment, capability, signature: trimmed as Hex });
      setStep({ status: "ready", prepared });
      notifications.notify({ status: "success", title: "Freeze authorised", detail: "The verifier accepted this signature. Submit the call to freeze the account." });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "The freeze could not be prepared.");
      setStep({ status: "signing" });
    }
  };

  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); notifications.notify({ status: "success", title: `${label} copied` }); }
    catch { notifications.notify({ status: "error", title: "Copy unavailable", detail: "Select the value and copy it manually." }); }
  };

  return <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Emergency freeze" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="review-sheet">
      <div className="sheet-handle" aria-hidden="true" />
      <div className="section-heading"><div><p className="eyebrow">{capability.accountAlias} · {shorten(capability.account)}</p><h2>Emergency freeze</h2></div></div>

      {step.status === "checking" && <p className="form-note">Re-reading the account's live guardian state…</p>}

      {step.status === "unavailable" && <>
        <p className="callout warning">{step.message}</p>
        <div className="sheet-actions"><span /><button className="secondary" onClick={onClose}>Close</button></div>
      </>}

      {step.status === "frozen" && <>
        <p className="callout success">This account is already frozen until {new Date(Number(step.until) * 1000).toLocaleString()}. No further action is needed.</p>
        <div className="sheet-actions"><span /><button className="secondary" onClick={onClose}>Close</button></div>
      </>}

      {(step.status === "signing" || step.status === "verifying") && <>
        <p>Freezing pauses ordinary execution for the contract's emergency window. It moves no funds, approves no recovery, and grants you no spending power.</p>
        <p className="callout warning">Your guardian commitment and Merkle proof become public when this is submitted. Only freeze if you believe the owner's key is compromised.</p>
        <label className="field"><span>Guardian signature over the freeze digest</span>
          <textarea value={signature} onChange={event => setSignature(event.target.value)} rows={3} placeholder="0x…" spellCheck={false} />
          <small className="form-note">
            Sign with the {capability.guardian.kind.toUpperCase()} key this capability commits to. The digest is re-derived from live chain state, so it cannot be replayed against a different configuration.
          </small>
        </label>
        {error && <p className="callout warning">{error}</p>}
        <div className="sheet-actions">
          <button className="secondary" onClick={onClose} disabled={step.status === "verifying"}>Cancel</button>
          <button className="danger-button" onClick={() => void verify()} disabled={step.status === "verifying" || signature.trim() === ""}>
            {step.status === "verifying" ? "Verifying with the verifier…" : "Verify signature"}
          </button>
        </div>
      </>}

      {step.status === "ready" && <>
        <p className="callout success">The verifier accepted this signature against the account's current configuration.</p>
        <div className="review-summary">
          <div><span>Config version</span><strong>{step.prepared.configVersion.toString()}</strong></div>
          <div><span>Freeze nonce</span><strong>{step.prepared.nonce.toString()}</strong></div>
          <div><span>Send to</span><strong className="breakable">{step.prepared.submit.to}</strong></div>
        </div>
        <ul className="effect-list">{step.prepared.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        <p className="form-note">
          Freezing is permissionless: any submitter can carry this call and none of them can alter it or gain authority by carrying it. This wallet holds no funded key for the account you protect, so submit the calldata below from any funded wallet or node.
        </p>
        <div className="guardian-actions">
          <button className="secondary" onClick={() => void copy("Calldata", step.prepared.submit.data)}>Copy calldata</button>
          <button className="secondary" onClick={() => void copy("Address", step.prepared.submit.to)}>Copy address</button>
        </div>
        <pre className="code-block breakable">{step.prepared.submit.data}</pre>
        <div className="sheet-actions"><span /><button className="secondary" onClick={onClose}>Done</button></div>
      </>}
    </div>
  </div>;
}
