import { PendingRecoveryBanner } from "../wallet/PendingRecoveryBanner";
import { useCallback, useEffect, useState } from "react";
import { AccountHeader, type BalanceView } from "../../components/AccountHeader";
import { describeAccountProtection } from "../security/accountProtection";
import { SecurityStatus } from "../../components/SecurityStatus";
import { SendDialog } from "../send/SendDialog";
import { ReceiveDialog } from "../wallet/ReceiveDialog";
import { useNetwork } from "../../config/NetworkContext";
import { useNotifications } from "../../notifications/NotificationsContext";
import { readAccountAssets, type AccountAssets, type NftAsset, type TokenAsset } from "../wallet/assets";
import { activateAccount } from "../wallet/activate";
import { transactionUrl } from "../../config/network";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import type { SendableAsset } from "../wallet/transfers";
import type { AccountHandle, NavigationArea } from "../../types";
import { useAppServices } from "../../app/AppServices";
import { AdvancedDetails, StatusPanel } from "../../components/StatusPanel";
import { reconcilePendingOperations } from "../../services/loom/pendingConfirmation";
import type { PendingOperation } from "../../storage/pendingOperations";
import { safeUserMessage } from "../../domain/errors/appError";

const EMPTY_ASSETS: AccountAssets = {
  native: { kind: "native", symbol: "ETH", name: "Ether", decimals: 18, balance: 0n, formatted: "0" },
  tokens: [], nfts: [], deployed: false, discoveryUnavailable: false, nftDiscoveryUnavailable: false
};

export function HomePage({ account, onNavigate, onSwitch, onLock, onStopRecovery }: {
  readonly account: AccountHandle;
  readonly onNavigate: (area: NavigationArea) => void;
  readonly onSwitch: () => void;
  readonly onLock: () => void;
  readonly onStopRecovery: () => void;
}) {
  const { config } = useNetwork();
  const notifications = useNotifications();
  const { runtime, pendingOperations, publicClients } = useAppServices();
  const [assets, setAssets] = useState<AccountAssets>(EMPTY_ASSETS);
  const [balance, setBalance] = useState<BalanceView>({ status: "loading" });
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [deployed, setDeployed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [send, setSend] = useState<{ open: boolean; preselect?: SendableAsset }>({ open: false });
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    readonly checking: boolean;
    readonly remaining: readonly PendingOperation[];
  }>({ checking: false, remaining: [] });
  const guardianThreshold = account.kind === "derived" ? account.creation.guardianThreshold : 0;

  const activate = async () => {
    if (!deployment) return;
    setActivating(true);
    const toast = notifications.notify({ status: "pending", title: "Creating account", detail: "Confirm with your passkey" });
    try {
      const result = await activateAccount({ config, account, deployment, runtime, pendingOperations, publicClients });
      notifications.update(toast, {
        status: "success",
        title: "Account created",
        detail: "It paid for its own creation and can now transact.",
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      await load(true);
    } catch (issue) {
      notifications.update(toast, {
        status: "error",
        title: "Account could not be created",
        detail: safeUserMessage(issue, "The creation operation failed.", "submission")
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
  const checkPending = useCallback(async () => {
    if (!deployment) return;
    setConfirmation(current => ({ ...current, checking: true }));
    try {
      await runtime.verify(config, deployment);
      await reconcilePendingOperations({
        config,
        account,
        store: pendingOperations,
        entryPoint: deployment.entryPoint,
        publicClient: publicClients.forEndpoint(config.rpcUrl),
        verificationPublicClient: publicClients.forEndpoint(config.verificationRpcUrl)
      });
      const remaining = await pendingOperations.list(account.id);
      setConfirmation({ checking: false, remaining });
    } catch {
      const remaining = await pendingOperations.list(account.id).catch(() => []);
      setConfirmation({ checking: false, remaining });
    }
  }, [account, config, deployment, pendingOperations, publicClients, runtime]);

  useEffect(() => { void checkPending(); }, [checkPending]);

  const refresh = async () => {
    await load(true);
    notifications.notify({ status: "info", title: "Balances refreshed", detail: `Read from ${hostOf(config.rpcUrl)}` });
  };

  const openSend = (preselect?: SendableAsset) => setSend({ open: true, ...(preselect ? { preselect } : {}) });

  return <div className="page-stack">
    {/* First on the screen: a recovery in flight replaces every validator on
        this account, and the owner is the only person who can say whether it
        is theirs. */}
    <PendingRecoveryBanner account={account} onStop={onStopRecovery} />
    <AccountHeader account={account.account} network={`Chain ${account.chainId}`} balance={balance} onSwitch={onSwitch} onLock={onLock} />

    <div className="quick-actions">
      <button onClick={() => setReceiveOpen(true)}><span aria-hidden="true">↓</span><span>Receive</span></button>
      <button onClick={() => openSend()}><span aria-hidden="true">↗</span><span>Send</span></button>
      <button onClick={() => void refresh()} disabled={refreshing}><span aria-hidden="true" className={refreshing ? "spin" : ""}>⟳</span><span>{refreshing ? "Refreshing" : "Refresh"}</span></button>
      <button onClick={() => onNavigate("activity")}><span aria-hidden="true">⋯</span><span>Activity</span></button>
    </div>

    {(confirmation.checking || confirmation.remaining.length > 0) && <StatusPanel tone="warning" busy={confirmation.checking}>
      <p className="eyebrow">Pending operation</p>
      <h2>{confirmation.checking ? "Checking the chain…" : "Confirmation is still pending"}</h2>
      <p>
        Loom will not request another passkey signature until the existing operation is independently verified by both configured RPCs.
      </p>
      {!confirmation.checking && <button className="secondary" onClick={() => void checkPending()}>Check again</button>}
      {confirmation.remaining.length > 0 && <AdvancedDetails>
        {confirmation.remaining.map(operation => <p key={operation.userOperationHash}><code>{operation.userOperationHash}</code></p>)}
      </AdvancedDetails>}
    </StatusPanel>}

    {balance.status === "loaded" && !deployed && account.kind === "derived" && <section className="section-card pending-card">
      <div>
        <p className="eyebrow">Not created yet</p>
        <h2>This account is created by its first operation</h2>
        <p>
          The address is reserved for your passkey, but the account exists on chain only once its first operation
          creates it — funding alone does not. Sending carries that creation along with it, so there is no separate
          step to take first. Creating it on its own is available here if you would rather not wait for a send.
        </p>
        {assets.native.balance === 0n && <p className="form-note">
          This address holds no ETH. Send it a small amount first: the account funds its own creation.
        </p>}
      </div>
      <button className="secondary" disabled={activating || !deployment || assets.native.balance === 0n} onClick={() => void activate()}>
        {activating ? "Confirm on your device…" : "Create account now"}
      </button>
    </section>}

    {guardianThreshold === 0 && <SecurityStatus
      protection={describeAccountProtection({ guardianThreshold: 0, recoveryConfigured: false, freezeActive: false, pendingRecovery: false })}
      onAddGuardians={() => onNavigate("security")}
    />}

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

    {receiveOpen && <ReceiveDialog address={account.account} chainId={account.chainId} deployed={deployed} onClose={() => setReceiveOpen(false)} />}

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


function hostOf(url: string): string { return url.replace(/^https?:\/\//, "").split("/")[0] ?? url; }
