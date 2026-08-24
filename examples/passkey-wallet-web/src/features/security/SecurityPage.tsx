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

type SafetyView =
  | { status: "loading" }
  | { status: "loaded"; state: AccountSafetyState }
  | { status: "error"; message: string };

export function SecurityPage({ account, onGuardian, onRecovery }: {
  readonly account: AccountHandle;
  readonly onGuardian: () => void;
  readonly onRecovery: () => void;
}) {
  const { config } = useNetwork();
  const localThreshold = account.kind === "derived" ? account.creation.guardianThreshold : 0;
  const [safety, setSafety] = useState<SafetyView>({ status: "loading" });
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [reloads, setReloads] = useState(0);

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

  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Authority and recovery</p><h1>Security</h1><p>Live module and recovery state for {account.label}, read independently from your configured RPC.</p></header>
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
