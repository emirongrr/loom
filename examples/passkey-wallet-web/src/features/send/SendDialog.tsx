import { useId, useMemo, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { AdvancedDetails, StatusPanel } from "../../components/StatusPanel";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { transactionUrl } from "../../config/network";
import { normalizeAppError, type AppError } from "../../domain/errors/appError";
import { operationIsPending, type OperationState } from "../../domain/operations/operationState";
import { useNotifications } from "../../notifications/NotificationsContext";
import type { AccountHandle } from "../../types";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import { submitAccountCalls } from "../wallet/accountClient";
import type { AccountAssets } from "../wallet/assets";
import { assetLabel, buildTransferCall, normalizeRecipient, type SendableAsset } from "../wallet/transfers";

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
  const { runtime, pendingOperations } = useAppServices();
  const options = useMemo<SendableAsset[]>(() => [
    { type: "token", token: assets.native },
    ...assets.tokens.map(token => ({ type: "token", token } as const)),
    ...assets.nfts.map(nft => ({ type: "nft", nft } as const))
  ], [assets]);

  const [assetKey, setAssetKey] = useState(() => keyOf(preselect ?? options[0]!));
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const [error, setError] = useState<AppError | null>(null);
  const errorId = useId();
  const busy = operationIsPending(operation);
  const asset = options.find(option => keyOf(option) === assetKey) ?? options[0]!;
  const isNft = asset.type === "nft";
  const available = asset.type === "token" ? `${asset.token.formatted} ${asset.token.symbol}` : `${asset.nft.collection} #${asset.nft.tokenId}`;

  const submit = async () => {
    setError(null);
    if (!deployment) {
      setError(normalizeAppError(new Error("Deployment configuration is still loading."), "configuration"));
      return;
    }
    let call;
    let recipient;
    try {
      recipient = normalizeRecipient(to);
      call = buildTransferCall({ asset, from: account.account, to: recipient, amount: isNft ? "1" : amount });
    } catch (issue) {
      setError(normalizeAppError(issue, "validation"));
      return;
    }

    const label = assetLabel(asset);
    const toastId = notifications.notify({ status: "pending", title: `Sending ${label}`, detail: `To ${short(recipient)} · waiting for confirmation` });
    try {
      await runtime.verify(config, deployment);
      const result = await submitAccountCalls({ config, account, deployment, calls: [call], onState: setOperation, pendingOperations });
      notifications.update(toastId, {
        status: "success",
        title: `Sent ${label}`,
        detail: `To ${short(recipient)}`,
        ...(result.transactionHash ? { href: transactionUrl(config, result.transactionHash), linkLabel: "View on explorer" } : {})
      });
      onSent?.();
      onClose();
    } catch (issue) {
      const appError = normalizeAppError(issue, "submission");
      notifications.update(toastId, { status: "error", title: `${label} failed`, detail: appError.userMessage });
      setError(appError);
    }
  };

  return <Dialog label="Send" busy={busy} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} aria-describedby={error ? errorId : undefined}>
      <div className="sheet-handle" aria-hidden="true" />
      <div className="section-heading"><div><p className="eyebrow">On {hostOf(config.rpcUrl)}</p><h2>Send</h2></div></div>

      {!deployed && <p className="callout warning">
        This account does not exist on chain yet, and funding it alone does not create it — it is created by its first
        operation. Use "Activate account" on the home screen first; it pays for itself from this balance.
      </p>}

      <label className="field"><span>Asset</span>
        <select value={assetKey} disabled={busy} onChange={event => { setAssetKey(event.target.value); setAmount(""); setError(null); }}>
          {options.map(option => <option key={keyOf(option)} value={keyOf(option)}>{optionLabel(option)}</option>)}
        </select>
        <small className="form-note">Available: {available}</small>
      </label>

      <label className="field"><span>Recipient address</span>
        <input value={to} disabled={busy} onChange={event => setTo(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={error?.stage === "validation" || undefined} />
      </label>

      {!isNft && <label className="field"><span>Amount ({asset.type === "token" ? asset.token.symbol : ""})</span>
        <div className="amount-row">
          <input value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} placeholder="0.0" inputMode="decimal" />
          {asset.type === "token" && <button type="button" className="text-button" disabled={busy} onClick={() => setAmount(asset.token.formatted)}>Max</button>}
        </div>
      </label>}
      {isNft && <p className="form-note">This transfers the single collectible shown above from your account.</p>}

      <div aria-live="polite">
        {error && <StatusPanel id={errorId} tone="warning">
          <p>{error.userMessage}</p>
          <AdvancedDetails><code>{error.code} · {error.stage}</code></AdvancedDetails>
        </StatusPanel>}
      </div>
      <div className="sheet-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !deployed}>{operationLabel(operation)}</button>
      </div>
    </form>
  </Dialog>;
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

function operationLabel(state: OperationState): string {
  switch (state.status) {
    case "validating": return "Checking transfer…";
    case "preparing": return "Preparing operation…";
    case "estimating": return "Estimating gas…";
    case "awaiting-passkey": return "Confirm on your device…";
    case "signing": return "Signing…";
    case "submitting": return "Submitting…";
    case "confirming": return "Waiting for confirmation…";
    default: return "Sign & send with passkey";
  }
}
