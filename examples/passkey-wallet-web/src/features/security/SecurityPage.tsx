import { useCallback, useEffect, useState } from "react";
import type { AccountSafetyState } from "@loom/sdk";
import { AdvancedDetails } from "../../components/StatusPanel";
import { describeAccountProtection } from "./accountProtection";
import { SecurityStatus } from "../../components/SecurityStatus";
import { useNetwork } from "../../config/NetworkContext";
import { readAccountSafety } from "../wallet/accountClient";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import { GuardianWorkspace } from "../guardians/GuardianWorkspace";
import { GuardianManager } from "./GuardianManager";
import type { AccountHandle } from "../../types";
import { safeUserMessage } from "../../domain/errors/appError";
import { authenticateBrowserAccount } from "../onboarding/accountLifecycle";
import { classifyPasskeyAvailability, dismissPasskeyGuidance, passkeyGuidanceDismissed } from "./passkeyAvailability";

type SafetyView =
  | { status: "loading" }
  | { status: "loaded"; state: AccountSafetyState }
  | { status: "error"; message: string };

export function SecurityPage({ account, onGuardian, onRecovery, onAccountUpdate }: {
  readonly account: AccountHandle;
  readonly onGuardian: () => void;
  readonly onRecovery: () => void;
  readonly onAccountUpdate: (account: AccountHandle) => Promise<void>;
}) {
  const { config } = useNetwork();
  const localThreshold = account.kind === "derived" ? account.creation.guardianThreshold : 0;
  const [safety, setSafety] = useState<SafetyView>({ status: "loading" });
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [reloads, setReloads] = useState(0);
  const [checkingPasskey, setCheckingPasskey] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState("");
  const [guidanceDismissed, setGuidanceDismissed] = useState(() => passkeyGuidanceDismissed(account.id));

  useEffect(() => {
    let active = true;
    setSafety({ status: "loading" });
    readAccountSafety(config, account)
      .then(state => { if (active) setSafety({ status: "loaded", state }); })
      .catch(error => { if (active) setSafety({ status: "error", message: safeUserMessage(error, "State could not be read.", "confirmation") }); });
    return () => { active = false; };
  }, [config, account, reloads]);

  useEffect(() => {
    let active = true;
    loadWalletDeployment().then(result => { if (active) setDeployment(result); }).catch(() => { if (active) setDeployment(null); });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(() => setReloads(count => count + 1), []);

  const [roster, setRoster] = useState<"mine" | "theirs">("mine");

  const chain = safety.status === "loaded" ? safety.state : null;
  const threshold = chain ? chain.config.guardianThreshold : localThreshold;
  const passkeyAvailability = classifyPasskeyAvailability(account.passkeyBackup);

  const checkPasskey = async () => {
    setCheckingPasskey(true); setPasskeyMessage("");
    try {
      const passkeyBackup = await authenticateBrowserAccount(account);
      await onAccountUpdate({ ...account, passkeyBackup });
      setPasskeyMessage("Passkey status was refreshed from a verified assertion.");
    } catch (error) {
      setPasskeyMessage(safeUserMessage(error, "Passkey status could not be checked.", "passkey"));
    } finally { setCheckingPasskey(false); }
  };

  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Authority and recovery</p><h1>Security</h1><p>Live module and recovery state for {account.label}, read independently from your configured RPC.</p></header>
    <section className={`section-card passkey-posture passkey-${passkeyAvailability}`}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Passkey availability</p>
          <h2>{passkeyAvailability === "backed-up" ? "Backup reported"
            : passkeyAvailability === "sync-pending" ? "Sync-capable, backup not yet reported"
            : passkeyAvailability === "authenticator-bound" ? "Bound to this authenticator"
            : "Backup status not checked"}</h2>
        </div>
        <span className="passkey-state-badge">{passkeyAvailability === "backed-up" ? "Ready"
          : passkeyAvailability === "sync-pending" ? "Review"
          : passkeyAvailability === "authenticator-bound" ? "Attention"
          : "Unknown"}</span>
      </div>
      <p>{passkeyAvailability === "backed-up"
        ? "The authenticator reported that this credential is backed up. Test Find with passkey on a second device before relying on it."
        : passkeyAvailability === "sync-pending"
          ? "This credential can be backed up, but the authenticator has not reported an active backup yet. Provider sync may still be pending."
          : passkeyAvailability === "authenticator-bound"
            ? "The provider does not report cloud backup for this credential. It may live on this device or on a roaming authenticator such as a YubiKey."
            : "Use the passkey once to read its current WebAuthn backup flags. This changes no wallet authority."}</p>
      <div className="landing-actions">
        <button className="secondary" disabled={checkingPasskey} onClick={() => void checkPasskey()}>{checkingPasskey ? "Checking…" : "Check with passkey"}</button>
        {threshold === 0 && <button className="primary" onClick={onGuardian}>Add guardians</button>}
      </div>
      {passkeyMessage && <p className="form-note" role="status">{passkeyMessage}</p>}
      {!guidanceDismissed && passkeyAvailability !== "backed-up" && <div className="passkey-options">
        <h3>Choose the protection that fits you</h3>
        <div className="permission-grid">
          <div><span>Cloud-synced passkey</span><strong>Google Password Manager, Apple Passwords, or another syncing provider</strong><small>Create/use the credential through your provider's native passkey picker and keep provider sync enabled.</small></div>
          <div><span>Platform passkey</span><strong>Windows Hello or the device credential store</strong><small>Convenient on this device. Whether it syncs depends on the platform and provider; Loom reads the reported result.</small></div>
          <div><span>Hardware authenticator</span><strong>YubiKey or another roaming security key</strong><small>Carry the authenticator to another device. It can be portable without being cloud-backed.</small></div>
          <div><span>Guardian recovery</span><strong>Independent recovery path</strong><small>Guardians can rotate authority to a newly verified passkey if this authenticator is lost.</small></div>
        </div>
        <p className="form-note">Loom cannot export a WebAuthn private key or force a specific provider. The browser and operating system own that choice.</p>
        <button className="text-button" onClick={() => { dismissPasskeyGuidance(account.id); setGuidanceDismissed(true); }}>Don't show these recommendations again</button>
      </div>}
    </section>
    {(() => {
      const protection = describeAccountProtection({
        guardianThreshold: threshold,
        recoveryConfigured: chain?.recoveryConfigured ?? threshold > 0,
        freezeActive: chain?.freeze.active ?? false,
        // `pending.recovery` is the decoded record, present whenever the
        // recovery module is readable. It is `active` that says a recovery is
        // actually held, and asking the wrong one told every guardian-
        // protected account that someone was recovering it.
        pendingRecovery: chain?.pending.recovery?.active === true
      });
      return <SecurityStatus
        protection={protection}
        {...(threshold > 0 ? { guardians: `${threshold}-of-${threshold} guardians` } : {})}
        onAddGuardians={onGuardian}
        onReviewRecovery={onRecovery}
      >
        {safety.status === "error" && <p className="form-note">
          State could not be read from {hostOf(config.rpcUrl)}, so this is not a claim that nothing is wrong.
          Check the endpoint in Developer settings.
        </p>}
        {chain && <AdvancedDetails>
          <div className="permission-grid">
            <div><span>Status</span><strong>{chain.status}</strong></div>
            <div><span>Config version</span><strong>{chain.config.configVersion.toString()}</strong></div>
            <div><span>Validators installed</span><strong>{chain.config.validatorCount.toString()}</strong></div>
            <div><span>Guardian threshold</span><strong>{chain.config.guardianThreshold}</strong></div>
          </div>
        </AdvancedDetails>}
      </SecurityStatus>;
    })()}


    {/* Two rosters, one for each direction the relationship runs. They were
        separate destinations, so seeing both meant leaving and coming back --
        and the guardian side was easy to forget entirely. */}
    <section className="section-card">
      <div className="roster-tabs" role="tablist" aria-label="Recovery relationships">
        <button role="tab" id="tab-mine" aria-selected={roster === "mine"} aria-controls="panel-mine"
          className={roster === "mine" ? "roster-tab active" : "roster-tab"} onClick={() => setRoster("mine")}>
          Guardians of this account
        </button>
        <button role="tab" id="tab-theirs" aria-selected={roster === "theirs"} aria-controls="panel-theirs"
          className={roster === "theirs" ? "roster-tab active" : "roster-tab"} onClick={() => setRoster("theirs")}>
          Accounts I protect
        </button>
      </div>
      {roster === "mine"
        ? <div role="tabpanel" id="panel-mine" aria-labelledby="tab-mine">
          <GuardianManager
            account={account}
            deployment={deployment}
            onChain={chain ? {
              root: chain.config.guardianRoot,
              threshold: chain.config.guardianThreshold,
              recoveryConfigured: chain.recoveryConfigured,
              configVersion: chain.config.configVersion
            } : null}
            onChanged={refresh}
          />
        </div>
        : <div role="tabpanel" id="panel-theirs" aria-labelledby="tab-theirs">
          <GuardianWorkspace account={account} embedded />
        </div>}
    </section>
  </div>;
}

function hostOf(url: string): string { return url.replace(/^https?:\/\//, "").split("/")[0] ?? url; }
