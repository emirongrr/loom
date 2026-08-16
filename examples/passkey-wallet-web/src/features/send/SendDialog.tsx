import { useEffect, useId, useMemo, useState } from "react";
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
import { planActivation } from "../wallet/activate";
import type { AccountAssets, TokenAsset } from "../wallet/assets";
import { assetLabel, buildTransferCall, normalizeRecipient, type SendableAsset } from "../wallet/transfers";
import { assessRecipient, type KnownAddress, type RecipientRisk } from "../wallet/recipientRisk";
import { nativeMaxAmount, nativeSendReserve } from "../wallet/sendLimits";
import { formatUnits, isAddress } from "viem";

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
  const { runtime, pendingOperations, publicClients } = useAppServices();
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
  // An account that does not exist yet is created by its first operation, so the
  // creation call rides along with this send rather than costing its own
  // ceremony. A handle whose configuration cannot be rebuilt has no safe
  // creation call, and must go through the home screen instead.
  const activation = useMemo(() => {
    if (deployed || !deployment || account.kind !== "derived") return null;
    try {
      const plan = planActivation(account, deployment);
      return { factory: plan.factory, factoryData: plan.factoryData };
    } catch { return null; }
  }, [account, deployment, deployed]);
  const known = useMemo<readonly KnownAddress[]>(() => Object.freeze([
    ...assets.tokens.filter(token => token.address).map(token => ({ address: token.address!, label: token.symbol, kind: "contract" as const })),
    ...assets.nfts.map(nft => ({ address: nft.contract, label: nft.collection, kind: "contract" as const }))
  ]), [assets]);
  const risks: readonly RecipientRisk[] = useMemo(
    () => (isAddress(to.trim(), { strict: false }) ? assessRecipient({ recipient: to.trim(), account: account.account, known }) : []),
    [to, account.account, known]
  );
  const available = asset.type === "token" ? `${asset.token.formatted} ${asset.token.symbol}` : `${asset.nft.collection} #${asset.nft.tokenId}`;

  // The account pays for its own operation out of the balance it is sending
  // from, so Max needs a fee price to know what it must leave behind. Without
  // one there is no honest maximum, and Max is withheld rather than guessed.
  const [feePrice, setFeePrice] = useState<bigint | null>(null);
  useEffect(() => {
    let active = true;
    // The client registry is a replaceable adapter, so treat a missing or
    // throwing fee reader as "unknown price" rather than letting it break the
    // whole send screen.
    void (async () => {
      try {
        const price = await publicClients.forEndpoint(config.rpcUrl).getGasPrice();
        if (active) setFeePrice(typeof price === "bigint" && price > 0n ? price * 2n : null);
      } catch { if (active) setFeePrice(null); }
    })();
    return () => { active = false; };
  }, [config.rpcUrl, publicClients]);

  const isNative = asset.type === "token" && asset.token.kind === "native";
  const maxUnavailable = isNative && feePrice === null;
  const maxAmountFor = (token: TokenAsset): string => {
    if (token.kind !== "native") return token.formatted;
    if (feePrice === null) return "";
    return formatUnits(nativeMaxAmount({ balance: token.balance, maxFeePerGas: feePrice }), token.decimals);
  };
  const gasReserve = isNative && feePrice !== null
    ? formatUnits(nativeSendReserve({ maxFeePerGas: feePrice }), asset.token.decimals)
    : null;

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
      const result = await submitAccountCalls({ config, account, deployment, calls: [call], ...(activation ? { activation } : {}), onState: setOperation, pendingOperations, runtime, publicClients });
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

      {!deployed && <p className={activation ? "callout" : "callout warning"} data-testid="first-send-notice">
        {activation
          ? "This account does not exist on chain yet. This send creates it and makes the transfer in one operation, paid from this balance — no separate activation step and no second passkey prompt. If the transfer itself fails, the account is still created and nothing is sent."
          : "This account does not exist on chain yet, and its creation call cannot be rebuilt from the saved handle. Create it from the home screen before sending."}
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

      {risks.length > 0 && <div className="callout warning" data-testid="recipient-risks" role="status">
        {risks.map((risk, index) => <p key={index}>{describeRisk(risk)}</p>)}
      </div>}

      {!isNft && <label className="field"><span>Amount ({asset.type === "token" ? asset.token.symbol : ""})</span>
        <div className="amount-row">
          <input value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} placeholder="0.0" inputMode="decimal" />
          {asset.type === "token" && <button type="button" className="text-button" disabled={busy || maxUnavailable} onClick={() => setAmount(maxAmountFor(asset.token))}>Max</button>}
        </div>
        {gasReserve && <small className="form-note" data-testid="gas-reserve">Max keeps {gasReserve} {asset.type === "token" ? asset.token.symbol : ""} back so this account can pay for its own transfer.</small>}
        {maxUnavailable && <small className="form-note" data-testid="gas-reserve-unavailable">The current fee price is unavailable, so Max cannot work out what to leave for gas. Enter an amount instead.</small>}
      </label>}
      {isNft && <p className="form-note">This transfers the single collectible shown above from your account.</p>}

      <div aria-live="polite">
        {error && <StatusPanel id={errorId} tone="warning">
          <p>{error.userMessage}</p>
          <AdvancedDetails>
            <p><code>{error.code} · {error.stage}</code></p>
            <p><code>{error.diagnostic}</code></p>
          </AdvancedDetails>
        </StatusPanel>}
      </div>
      <div className="sheet-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || (!deployed && !activation)}>{operationLabel(operation)}</button>
      </div>
    </form>
  </Dialog>;
}

function describeRisk(risk: RecipientRisk): string {
  switch (risk.kind) {
    case "self":
      return "This is this account's own address. The transfer would send the asset back to itself and still cost gas.";
    case "burn":
      return "This is the zero address. Anything sent there is destroyed and cannot be recovered by anyone.";
    case "contract":
      return `This is the ${risk.label} contract itself, not a wallet. Tokens sent to their own contract are usually unrecoverable.`;
    case "look-alike":
      return `This address begins and ends like ${risk.label} (${risk.similarTo}) but is not the same address. Address-poisoning attacks rely on exactly this. Compare every character before sending.`;
  }
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
