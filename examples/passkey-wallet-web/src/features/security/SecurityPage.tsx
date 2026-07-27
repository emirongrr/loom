import { useCallback, useEffect, useState } from "react";
import type { AccountSafetyState } from "@loom/sdk";
import { SecurityStatus } from "../../components/SecurityStatus";
import { useNetwork } from "../../config/NetworkContext";
import { readAccountSafety } from "../wallet/accountClient";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import { GuardianManager } from "./GuardianManager";
import type { AccountHandle } from "../../types";

type SafetyView =
  | { status: "loading" }
  | { status: "loaded"; state: AccountSafetyState }
  | { status: "error"; message: string };

export function SecurityPage({ account, onGuardian }: { readonly account: AccountHandle; readonly onGuardian: () => void }) {
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
      .catch(error => { if (active) setSafety({ status: "error", message: error instanceof Error ? error.message : "State could not be read" }); });
    return () => { active = false; };
  }, [config, account, reloads]);

  useEffect(() => {
    let active = true;
    loadWalletDeployment().then(result => { if (active) setDeployment(result); }).catch(() => { if (active) setDeployment(null); });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(() => setReloads(count => count + 1), []);

  const chain = safety.status === "loaded" ? safety.state : null;
  const threshold = chain ? chain.config.guardianThreshold : localThreshold;

  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Authority and recovery</p><h1>Security</h1><p>Live module and recovery state for {account.label}, read independently from your configured RPC.</p></header>
    <SecurityStatus guardians={threshold > 0 ? threshold : 0} threshold={threshold} frozen={chain?.freeze.active ?? false} pendingRecovery={Boolean(chain?.pending.recovery)} />
    <GuardianManager
      account={account}
      deployment={deployment}
      onChain={chain ? { root: chain.config.guardianRoot, threshold: chain.config.guardianThreshold } : null}
      onChanged={refresh}
    />

    <section className="section-card">
      <p className="eyebrow">Primary access</p><h2>Passkey</h2>
      <div className="security-row"><span className="round-icon">◆</span><div><strong>{account.rpId}</strong><p>The private credential stays in this device's authenticator and never reaches the page.</p></div><span className="pill included">Active</span></div>
      <button className="secondary" onClick={onGuardian}>Accounts I protect</button>
    </section>
    <section className="section-card"><div className="section-heading"><div><p className="eyebrow">Installed authority</p><h2>On-chain state</h2></div>{stateBadge(safety)}</div>
      {safety.status === "loading" && <p>Reading account state from {hostOf(config.rpcUrl)}…</p>}
      {safety.status === "error" && <p>State could not be read from {hostOf(config.rpcUrl)}. Check the RPC endpoint in Developer settings. ({safety.message})</p>}
      {chain && <div className="permission-grid">
        <div><span>Status</span><strong>{chain.status}</strong></div>
        <div><span>Config version</span><strong>{chain.config.configVersion.toString()}</strong></div>
        <div><span>Validators installed</span><strong>{chain.config.validatorCount.toString()}</strong></div>
        <div><span>Guardian threshold</span><strong>{chain.config.guardianThreshold}</strong></div>
        <div><span>Freeze</span><strong>{chain.freeze.active ? "Active" : "None"}</strong></div>
        <div><span>Pending recovery</span><strong>{chain.pending.recovery ? "Yes" : "No"}</strong></div>
      </div>}
    </section>
  </div>;
}

function stateBadge(safety: SafetyView) {
  if (safety.status === "loading") return <span className="pill">Loading</span>;
  if (safety.status === "error") return <span className="pill failed">Unavailable</span>;
  return <span className="pill included">Live</span>;
}

function hostOf(url: string): string { return url.replace(/^https?:\/\//, "").split("/")[0] ?? url; }
