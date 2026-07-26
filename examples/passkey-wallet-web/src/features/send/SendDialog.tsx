import { useState } from "react";
import type { Address } from "@loom/core";
import { isAddress, parseEther } from "viem";
import { useNetwork } from "../../config/NetworkContext";
import { transactionUrl } from "../../config/network";
import { sendEthTransfer } from "../wallet/accountClient";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { AccountHandle } from "../../types";

type SendState =
  | { status: "editing" }
  | { status: "submitting" }
  | { status: "sent"; userOpHash: string; transactionHash?: string }
  | { status: "error"; message: string };

export function SendDialog({ account, deployment, deployed, onClose }: {
  account: AccountHandle;
  deployment: WalletDeployment | null;
  deployed: boolean;
  onClose(): void;
}) {
  const { config } = useNetwork();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<SendState>({ status: "editing" });

  const parsedValue = safeParseEther(amount);
  const recipientValid = isAddress(to.trim());
  const canSubmit = deployed && deployment !== null && recipientValid && parsedValue !== null && parsedValue > 0n && state.status === "editing";

  const submit = async () => {
    if (!deployment || parsedValue === null) return;
    setState({ status: "submitting" });
    try {
      const result = await sendEthTransfer({ config, account, deployment, to: to.trim() as Address, valueWei: parsedValue });
      setState({ status: "sent", userOpHash: result.userOpHash, ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}) });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "The transaction could not be submitted." });
    }
  };

  return <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Send ETH" onClick={event => { if (event.target === event.currentTarget && state.status !== "submitting") onClose(); }}>
    <div className="review-sheet">
      <div className="sheet-handle" aria-hidden="true" />
      <div className="section-heading"><div><p className="eyebrow">On {config.rpcUrl.replace(/^https?:\/\//, "").split("/")[0]}</p><h2>Send ETH</h2></div></div>

      {state.status === "sent" ? <>
        <p className="callout success">Submitted to the bundler. The account paid from its own balance; the bundler held no authority over the operation.</p>
        <div className="review-summary">
          <div><span>Operation hash</span><strong className="breakable">{state.userOpHash}</strong></div>
          {state.transactionHash && <div><span>Transaction</span><a className="breakable" href={transactionUrl(config, state.transactionHash)} target="_blank" rel="noreferrer noopener">{state.transactionHash}</a></div>}
        </div>
        <div className="sheet-actions"><span /><button className="primary" onClick={onClose}>Done</button></div>
      </> : <>
        {!deployed && <p className="callout warning">This account has no code on chain yet. Fund the address so its first operation can deploy it, then send.</p>}
        <label className="field"><span>Recipient address</span><input value={to} onChange={event => setTo(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" /></label>
        {to.trim() !== "" && !recipientValid && <p className="form-note">Enter a valid 20-byte Ethereum address.</p>}
        <label className="field"><span>Amount (ETH)</span><input value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.0" inputMode="decimal" /></label>
        {amount.trim() !== "" && parsedValue === null && <p className="form-note">Enter an amount in ETH, for example 0.01.</p>}
        {state.status === "error" && <p className="callout warning">{state.message}</p>}
        <div className="sheet-actions">
          <button className="secondary" onClick={onClose} disabled={state.status === "submitting"}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!canSubmit}>{state.status === "submitting" ? "Confirm on your device…" : "Sign & send with passkey"}</button>
        </div>
      </>}
    </div>
  </div>;
}

function safeParseEther(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  try { return parseEther(trimmed as `${number}`); } catch { return null; }
}
