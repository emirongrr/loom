import { useMemo, useState } from "react";
import { useNetwork } from "../../config/NetworkContext";
import { transactionUrl } from "../../config/network";
import { useNotifications } from "../../notifications/NotificationsContext";
import { submitAccountCalls } from "../wallet/accountClient";
import { assetLabel, buildTransferCall, normalizeRecipient, type SendableAsset } from "../wallet/transfers";
import type { AccountAssets } from "../wallet/assets";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";

export function SendDialog({ account, deployment, deployed, assets, preselect, onClose, onSent }: {
  account: AccountHandle;
  deployment: WalletDeployment | null;
  deployed: boolean;
  assets: AccountAssets;
  preselect?: SendableAsset;
  onClose(): void;
  onSent?(): void;
}) {
  const { config } = useNetwork();
  const notifications = useNotifications();

  const options = useMemo<SendableAsset[]>(() => [
    { type: "token", token: assets.native },
    ...assets.tokens.map(token => ({ type: "token", token } as const)),
    ...assets.nfts.map(nft => ({ type: "nft", nft } as const))
  ], [assets]);

  const [assetKey, setAssetKey] = useState(() => keyOf(preselect ?? options[0]!));
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const asset = options.find(option => keyOf(option) === assetKey) ?? options[0]!;
  const isNft = asset.type === "nft";
  const available = asset.type === "token" ? `${asset.token.formatted} ${asset.token.symbol}` : `${asset.nft.collection} #${asset.nft.tokenId}`;

  const submit = async () => {
    setError("");
    if (!deployment) { setError("Deployment configuration is still loading."); return; }
    let call;
    let recipient;
    try {
      recipient = normalizeRecipient(to);
      call = buildTransferCall({ asset, from: account.account, to: recipient, amount: isNft ? "1" : amount });
    } catch (issue) { setError(issue instanceof Error ? issue.message : "Check the recipient and amount."); return; }

    setBusy(true);
    const label = assetLabel(asset);
    const toastId = notifications.notify({ status: "pending", title: `Sending ${label}`, detail: `To ${short(recipient)} · waiting for confirmation` });
    try {
      const result = await submitAccountCalls({ config, account, deployment, calls: [call] });
      notifications.update(toastId, {
        status: "success",
        title: `Sent ${label}`,
        detail: `To ${short(recipient)}`,
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      onSent?.();
      onClose();
    } catch (issue) {
      const message = issue instanceof Error ? issue.message : "The transaction could not be submitted.";
      notifications.update(toastId, { status: "error", title: `${label} failed`, detail: message });
      setError(message);
    } finally { setBusy(false); }
  };

  return <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Send" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="review-sheet">
      <div className="sheet-handle" aria-hidden="true" />
      <div className="section-heading"><div><p className="eyebrow">On {hostOf(config.rpcUrl)}</p><h2>Send</h2></div></div>

      {!deployed && <p className="callout warning">This account has no code on chain yet. Fund the address so its first operation can deploy it, then send.</p>}

      <label className="field"><span>Asset</span>
        <select value={assetKey} onChange={event => { setAssetKey(event.target.value); setAmount(""); setError(""); }}>
          {options.map(option => <option key={keyOf(option)} value={keyOf(option)}>{optionLabel(option)}</option>)}
        </select>
        <small className="form-note">Available: {available}</small>
      </label>

      <label className="field"><span>Recipient address</span>
        <input value={to} onChange={event => setTo(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
      </label>

      {!isNft && <label className="field"><span>Amount ({asset.type === "token" ? asset.token.symbol : ""})</span>
        <div className="amount-row">
          <input value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.0" inputMode="decimal" />
          {asset.type === "token" && <button type="button" className="text-button" onClick={() => setAmount(asset.token.formatted)}>Max</button>}
        </div>
      </label>}
      {isNft && <p className="form-note">This transfers the single collectible shown above from your account.</p>}

      {error && <p className="callout warning">{error}</p>}
      <div className="sheet-actions">
        <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || !deployed}>{busy ? "Confirm on your device…" : "Sign & send with passkey"}</button>
      </div>
    </div>
  </div>;
}

function keyOf(asset: SendableAsset): string {
  return asset.type === "token"
    ? `t:${asset.token.kind === "native" ? "native" : asset.token.address}`
    : `n:${asset.nft.contract}:${asset.nft.tokenId}`;
}

function optionLabel(asset: SendableAsset): string {
  return asset.type === "token"
    ? `${asset.token.symbol} — ${asset.token.formatted}`
    : `${asset.nft.collection} #${asset.nft.tokenId}`;
}

function short(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
function hostOf(url: string): string { return url.replace(/^https?:\/\//, "").split("/")[0] ?? url; }
