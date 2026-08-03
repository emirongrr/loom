import { useEffect, useState } from "react";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { GUARDIAN_ACCOUNT_LABEL } from "../security/guardianInvitation";
import { useNetwork } from "../../config/NetworkContext";
import { useNotifications } from "../../notifications/NotificationsContext";
import { shorten } from "../../components/AccountHeader";
import { Dialog } from "../../components/Dialog";
import { useAppServices } from "../../app/AppServices";
import { safeUserMessage } from "../../domain/errors/appError";
import { prepareGuardianFreeze, prepareGuardianFreezeChallenge, readFreezeState, type FreezePreparation } from "./freeze";
import { guardianCapabilityMatchesAccount, signFreezeDigestWithPasskey } from "./freezeSigning";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";

type Step =
  | { status: "checking" }
  | { status: "unavailable"; message: string }
  | { status: "frozen"; until: bigint }
  | { status: "signing" }
  | { status: "verifying" }
  | { status: "ready"; prepared: FreezePreparation };

export function FreezeDialog({ capability, deployment, guardianAccount, onClose }: {
  capability: GuardianInviteV1;
  deployment: WalletDeployment;
  guardianAccount: AccountHandle;
  onClose(): void;
}) {
  const { config } = useNetwork();
  const { publicClients } = useAppServices();
  const notifications = useNotifications();
  const [step, setStep] = useState<Step>({ status: "checking" });
  const [error, setError] = useState("");
  const matchesOpenWallet = guardianCapabilityMatchesAccount(capability, guardianAccount);
  const canUsePasskey = matchesOpenWallet && capability.guardian.kind === "p256";

  useEffect(() => {
    let active = true;
    readFreezeState({ config, deployment, capability, publicClients })
      .then(state => {
        if (!active) return;
        if (state.active) setStep({ status: "frozen", until: state.frozenUntil });
        else if (!state.recoveryConfigured) setStep({ status: "unavailable", message: "This account has no active guardian recovery, so it cannot be frozen." });
        else setStep({ status: "signing" });
      })
      .catch(issue => { if (active) setStep({ status: "unavailable", message: safeUserMessage(issue, "Account state could not be read.", "confirmation") }); });
    return () => { active = false; };
  }, [config, deployment, capability, publicClients]);

  const authorize = async () => {
    setError("");
    setStep({ status: "verifying" });
    try {
      const challenge = await prepareGuardianFreezeChallenge({ config, deployment, capability, publicClients });
      const signature = await signFreezeDigestWithPasskey({
        capability,
        account: guardianAccount,
        digest: challenge.digest
      });
      // Re-read and verify after the passkey ceremony. A changed config or
      // nonce invalidates the assertion instead of submitting stale authority.
      const prepared = await prepareGuardianFreeze({ config, deployment, capability, signature, publicClients });
      setStep({ status: "ready", prepared });
      notifications.notify({ status: "success", title: "Freeze authorised", detail: "Your passkey approved the exact live freeze request." });
    } catch (issue) {
      setError(safeUserMessage(issue, "The freeze could not be prepared.", "preparation"));
      setStep({ status: "signing" });
    }
  };

  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); notifications.notify({ status: "success", title: `${label} copied` }); }
    catch { notifications.notify({ status: "error", title: "Copy unavailable", detail: "Select the value and copy it manually." }); }
  };

  return <Dialog label="Emergency freeze" busy={step.status === "verifying"} onClose={onClose}>
      <div className="sheet-handle" aria-hidden="true" />
      <div className="section-heading"><div><p className="eyebrow">{GUARDIAN_ACCOUNT_LABEL} · {shorten(capability.account)}</p><h2>Emergency freeze</h2></div></div>

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
        {canUsePasskey
          ? <p className="callout">The open wallet matches this direct P-256 guardian. Your passkey will approve the exact live freeze request; no signature copying is needed.</p>
          : <p className="callout warning">{matchesOpenWallet && capability.guardian.kind === "erc1271"
              ? "This Loom wallet was saved through the legacy smart-contract path, whose P-256 validator cannot sign arbitrary ERC-1271 digests. Ask the owner to remove this guardian and add the same address again through the delayed guardian change."
              : capability.guardian.kind === "ecdsa"
                ? "This guardian was saved through the legacy ECDSA path. If it is a Loom account, ask the owner to remove it and add the same address again so Loom can resolve its P-256 authority."
                : "Open the Loom wallet whose P-256 key matches this guardian capability, then try again."}</p>}
        {error && <p className="callout warning">{error}</p>}
        <div className="sheet-actions">
          <button className="secondary" onClick={onClose} disabled={step.status === "verifying"}>Cancel</button>
          {canUsePasskey && <button className="danger-button" onClick={() => void authorize()} disabled={step.status === "verifying"}>
            {step.status === "verifying" ? "Confirming with passkey…" : "Confirm freeze with passkey"}
          </button>}
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
  </Dialog>;
}
