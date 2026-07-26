import { useEffect, useState } from "react";
import { AccountHeader, type BalanceView } from "../../components/AccountHeader";
import { SecurityStatus } from "../../components/SecurityStatus";
import { SendDialog } from "../send/SendDialog";
import { useNetwork } from "../../config/NetworkContext";
import { readAccountBalance } from "../wallet/accountClient";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle, NavigationArea } from "../../types";

export function HomePage({ account, onNavigate, onSwitch, onLock }: {
  readonly account: AccountHandle;
  readonly onNavigate: (area: NavigationArea) => void;
  readonly onSwitch: () => void;
  readonly onLock: () => void;
}) {
  const { config } = useNetwork();
  const [message, setMessage] = useState("");
  const [balance, setBalance] = useState<BalanceView>({ status: "loading" });
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [sending, setSending] = useState(false);
  const guardianThreshold = account.kind === "derived" ? account.creation.guardianThreshold : 0;

  useEffect(() => {
    let active = true;
    setBalance({ status: "loading" });
    readAccountBalance(config, account.account)
      .then(result => { if (active) setBalance({ status: "loaded", eth: result.eth, deployed: result.deployed }); })
      .catch(() => { if (active) setBalance({ status: "error" }); });
    return () => { active = false; };
  }, [config, account.account]);

  useEffect(() => {
    let active = true;
    loadWalletDeployment().then(result => { if (active) setDeployment(result); }).catch(() => { if (active) setDeployment(null); });
    return () => { active = false; };
  }, []);

  const copyAddress = async () => {
    try { await navigator.clipboard.writeText(account.account); setMessage("Receive address copied."); }
    catch { setMessage("Copy was unavailable. Select the address and copy it manually."); }
  };

  return <div className="page-stack">
    <AccountHeader account={account.account} network={`Chain ${account.chainId}`} balance={balance} onSwitch={onSwitch} onLock={onLock} />
    <div className="quick-actions">
      <button onClick={copyAddress}><span aria-hidden="true">↓</span><span>Receive</span></button>
      <button onClick={() => setSending(true)}><span aria-hidden="true">↗</span><span>Send</span></button>
      <button onClick={() => onNavigate("security")}><span aria-hidden="true">◆</span><span>Security</span></button>
      <button onClick={() => onNavigate("activity")}><span aria-hidden="true">⋯</span><span>Activity</span></button>
    </div>
    {message && <p className="toast" role="status">{message}</p>}
    <SecurityStatus guardians={guardianThreshold > 0 ? guardianThreshold : 0} threshold={guardianThreshold} frozen={false} pendingRecovery={false} />
    <section className="section-card">
      <div className="section-heading"><div><p className="eyebrow">Account</p><h2>{account.label}</h2></div><span className="pill included">{account.kind}</span></div>
      <div className="permission-grid"><div><span>Address</span><strong className="breakable">{account.account}</strong></div><div><span>Chain</span><strong>{account.chainId}</strong></div><div><span>Passkey RP ID</span><strong>{account.rpId}</strong></div><div><span>Recovery</span><strong>{guardianThreshold > 0 ? `${guardianThreshold}-approval threshold` : "Not configured"}</strong></div></div>
    </section>
    {guardianThreshold === 0 && <section className="section-card pending-card"><div><p className="eyebrow">Action required</p><h2>Recovery is not configured</h2><p>This account is stored locally, but losing the matching passkey can still mean losing access.</p></div><button className="secondary" onClick={() => onNavigate("security")}>Open Security</button></section>}
    {sending && <SendDialog account={account} deployment={deployment} deployed={balance.status === "loaded" ? balance.deployed === true : false} onClose={() => setSending(false)} />}
  </div>;
}
