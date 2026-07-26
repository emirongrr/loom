import { useEffect, useState } from "react";
import type { AccountSafetyState } from "@loom/sdk";
import { SecurityStatus } from "../../components/SecurityStatus";
import { useNetwork } from "../../config/NetworkContext";
import { readAccountSafety } from "../wallet/accountClient";
import type { AccountHandle } from "../../types";

type SafetyView =
  | { status: "loading" }
  | { status: "loaded"; state: AccountSafetyState }
  | { status: "error"; message: string };

export function SecurityPage({ account, onGuardian }: { readonly account: AccountHandle; readonly onGuardian: () => void }) {
  const { config } = useNetwork();
  const localThreshold = account.kind === "derived" ? account.creation.guardianThreshold : 0;
  const [safety, setSafety] = useState<SafetyView>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setSafety({ status: "loading" });
    readAccountSafety(config, account)
      .then(state => { if (active) setSafety({ status: "loaded", state }); })
      .catch(error => { if (active) setSafety({ status: "error", message: error instanceof Error ? error.message : "State could not be read" }); });
    return () => { active = false; };
  }, [config, account]);

  const chain = safety.status === "loaded" ? safety.state : null;
  const threshold = chain ? chain.config.guardianThreshold : localThreshold;

  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Authority and recovery</p><h1>Security</h1><p>Live module and recovery state for {account.label}, read independently from your configured RPC.</p></header>
    <SecurityStatus guardians={threshold > 0 ? threshold : 0} threshold={threshold} frozen={chain?.freeze.active ?? false} pendingRecovery={Boolean(chain?.pending.recovery)} />
    <div className="security-grid">
      <section className="section-card"><p className="eyebrow">Primary access</p><h2>Passkey handle</h2><div className="security-row"><span className="round-icon">◆</span><div><strong>{account.rpId}</strong><p>Credential ID is stored publicly; the private credential remains in the authenticator.</p></div><span className="pill included">Saved</span></div></section>
      <section className="section-card"><p className="eyebrow">Recovery quorum</p><h2>Guardian protection</h2>{threshold > 0 ? <div className="quorum"><strong>{threshold}</strong><span>approval threshold</span></div> : <p>No guardian recovery is configured. Add independent guardians so a lost passkey does not mean a lost account.</p>}<button className="secondary" onClick={onGuardian}>Open guardian workspace</button></section>
    </div>
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
