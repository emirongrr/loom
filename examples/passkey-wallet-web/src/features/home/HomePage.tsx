import { useCallback, useEffect, useState } from "react";
import { AccountHeader, type BalanceView } from "../../components/AccountHeader";
import { SecurityStatus } from "../../components/SecurityStatus";
import { SendDialog } from "../send/SendDialog";
import { useNetwork } from "../../config/NetworkContext";
import { useNotifications } from "../../notifications/NotificationsContext";
import { readAccountAssets, type AccountAssets, type NftAsset, type TokenAsset } from "../wallet/assets";
import { prepareActivation, submitActivation } from "../wallet/activate";
import { transactionUrl } from "../../config/network";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import type { SendableAsset } from "../wallet/transfers";
import type { AccountHandle, NavigationArea } from "../../types";

const EMPTY_ASSETS: AccountAssets = {
  native: { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 0n, formatted: "0" },
  tokens: [], nfts: [], deployed: false, discoveryUnavailable: false, nftDiscoveryUnavailable: false
};

export function HomePage({ account, onNavigate, onSwitch, onLock }: {
  readonly account: AccountHandle;
  readonly onNavigate: (area: NavigationArea) => void;
  readonly onSwitch: () => void;
  readonly onLock: () => void;
}) {
  const { config } = useNetwork();
  const notifications = useNotifications();
  const [assets, setAssets] = useState<AccountAssets>(EMPTY_ASSETS);
  const [balance, setBalance] = useState<BalanceView>({ status: "loading" });
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [deployed, setDeployed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [send, setSend] = useState<{ open: boolean; preselect?: SendableAsset }>({ open: false });
  const [activating, setActivating] = useState(false);
  const guardianThreshold = account.kind === "derived" ? account.creation.guardianThreshold : 0;

  const activate = async () => {
    if (!deployment) return;
    setActivating(true);
    const toast = notifications.notify({ status: "pending", title: "Creating account", detail: "Confirm with your passkey" });
    try {
      const preparation = await prepareActivation({ account, deployment, balanceWei: assets.native.balance });
      notifications.update(toast, {
        status: "pending",
        title: "Publishing account",
        detail: preparation.selfFunded ? "The account pays for its own creation." : "A submitter is funding this creation."
      });
      const result = await submitActivation({ config, preparation });
      notifications.update(toast, {
        status: "success",
        title: result.alreadyDeployed ? "Account already exists" : "Account created",
        detail: "It can now send transactions through any bundler.",
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      await load(true);
    } catch (issue) {
      notifications.update(toast, {
        status: "error",
        title: "Account could not be created",
        detail: issue instanceof Error ? issue.message : "The creation operation failed."
      });
    } finally { setActivating(false); }
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setBalance({ status: "loading" });
    setRefreshing(true);
    try {
      const [next] = await Promise.all([
        readAccountAssets(config, account.account),
        loadWalletDeployment().then(setDeployment).catch(() => setDeployment(null))
      ]);
      setDeployed(next.deployed);
      setAssets(next);
      setBalance({ status: "loaded", eth: next.native.formatted, deployed: next.deployed });
    } catch {
      setBalance({ status: "error" });
    } finally { setRefreshing(false); }
  }, [config, account.account]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    await load(true);
    notifications.notify({ status: "info", title: "Balances refreshed", detail: `Read from ${hostOf(config.rpcUrl)}` });
  };

  const openSend = (preselect?: SendableAsset) => setSend({ open: true, ...(preselect ? { preselect } : {}) });

  return <div className="page-stack">
    <AccountHeader account={account.account} network={`Chain ${account.chainId}`} balance={balance} onSwitch={onSwitch} onLock={onLock} />

    <div className="quick-actions">
      <button onClick={() => void copyAddress(account.account, notifications)}><span aria-hidden="true">↓</span><span>Receive</span></button>
      <button onClick={() => openSend()}><span aria-hidden="true">↗</span><span>Send</span></button>
      <button onClick={() => void refresh()} disabled={refreshing}><span aria-hidden="true" className={refreshing ? "spin" : ""}>⟳</span><span>{refreshing ? "Refreshing" : "Refresh"}</span></button>
      <button onClick={() => onNavigate("activity")}><span aria-hidden="true">⋯</span><span>Activity</span></button>
    </div>

    {balance.status === "loaded" && !deployed && account.kind === "derived" && <section className="section-card pending-card">
      <div>
        <p className="eyebrow">Not created yet</p>
        <h2>Activate this account</h2>
        <p>
          The address is reserved for your passkey, but the account does not exist on chain until its first operation
          creates it — funding alone does not. This factory accepts that operation only from the EntryPoint, so a public
          bundler cannot carry it and a submitter publishes it instead. Your passkey signs it; the submitter cannot
          change it or gain any authority over the account.
        </p>
        {config.relayUrl.trim() === "" && <p className="form-note">
          No submitter is configured. Add a sponsor relay in Developer settings, or publish the signed operation from any funded wallet.
        </p>}
      </div>
      <button className="primary" disabled={activating || !deployment || config.relayUrl.trim() === ""} onClick={() => void activate()}>
        {activating ? "Confirm on your device…" : "Activate account"}
      </button>
    </section>}

    {guardianThreshold === 0 && <SecurityStatus guardians={0} threshold={0} frozen={false} pendingRecovery={false} />}

    <section className="section-card">
      <div className="section-heading"><div><p className="eyebrow">Assets</p><h2>Tokens</h2></div><button className="icon-button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh balances"><span className={refreshing ? "spin" : ""}>⟳</span></button></div>
      <div className="asset-list">
        <AssetRow token={assets.native} onSend={() => openSend({ type: "token", token: assets.native })} />
        {assets.tokens.map(token => <AssetRow key={token.address} token={token} onSend={() => openSend({ type: "token", token })} />)}
      </div>
      {balance.status === "loading" && assets.tokens.length === 0 && <p className="form-note">Loading balances from {hostOf(config.rpcUrl)}…</p>}
      {assets.discoveryUnavailable && <p className="form-note">Token discovery is unavailable from the configured explorer; only the native balance is shown. Change the explorer in Developer settings.</p>}
    </section>

    <section className="section-card">
      <div className="section-heading"><div><p className="eyebrow">Collectibles</p><h2>NFTs</h2></div></div>
      {assets.nftDiscoveryUnavailable
        ? <p className="form-note">Collectible discovery is unavailable from the configured explorer right now. Token balances above are unaffected.</p>
        : assets.nfts.length === 0
          ? <p className="form-note">No ERC-721 or ERC-1155 collectibles were found for this account.</p>
          : <div className="nft-grid">{assets.nfts.map(nft => <NftCard key={`${nft.contract}:${nft.tokenId}`} nft={nft} onSend={() => openSend({ type: "nft", nft })} />)}</div>}
    </section>

    {guardianThreshold === 0 && <section className="section-card pending-card"><div><p className="eyebrow">Action required</p><h2>Recovery is not configured</h2><p>This account is stored locally, but losing the matching passkey can still mean losing access.</p></div><button className="secondary" onClick={() => onNavigate("security")}>Open Security</button></section>}

    {send.open && <SendDialog account={account} deployment={deployment} deployed={deployed} assets={assets} {...(send.preselect ? { preselect: send.preselect } : {})} onClose={() => setSend({ open: false })} onSent={() => void load(true)} />}
  </div>;
}

function AssetRow({ token, onSend }: { token: TokenAsset; onSend(): void }) {
  return <div className="asset-row">
    {token.icon
      ? <img className="asset-icon" src={token.icon} alt="" loading="lazy" />
      : <span className={`asset-icon ${token.kind === "native" ? "eth" : ""}`} aria-hidden="true">{token.symbol.slice(0, 3).toUpperCase()}</span>}
    <div><strong>{token.name}</strong><span>{token.symbol}</span></div>
    <div className="asset-amount"><strong>{token.formatted}</strong><button className="text-button" onClick={onSend}>Send</button></div>
  </div>;
}

function NftCard({ nft, onSend }: { nft: NftAsset; onSend(): void }) {
  return <article className="nft-card">
    <div className="nft-media">{nft.image
      ? <img src={nft.image} alt={nft.name} loading="lazy" onError={event => { event.currentTarget.style.display = "none"; }} />
      : <span aria-hidden="true">◈</span>}</div>
    <div className="nft-meta"><strong>{nft.name}</strong><span>{nft.collection}</span></div>
    <button className="secondary" onClick={onSend}>Send</button>
  </article>;
}

async function copyAddress(address: string, notifications: ReturnType<typeof useNotifications>) {
  try { await navigator.clipboard.writeText(address); notifications.notify({ status: "success", title: "Address copied", detail: "Share it to receive funds." }); }
  catch { notifications.notify({ status: "error", title: "Copy unavailable", detail: "Select the address and copy it manually." }); }
}

function hostOf(url: string): string { return url.replace(/^https?:\/\//, "").split("/")[0] ?? url; }
