import type { Address } from "@loom/core";

export interface BalanceView {
  readonly status: "loading" | "loaded" | "error";
  readonly eth?: string;
  readonly deployed?: boolean;
}

export function AccountHeader({ account, network, balance, onSwitch, onLock }: {
  account?: Address;
  network: string;
  balance: BalanceView;
  onSwitch(): void;
  onLock(): void;
}) {
  return <section className="account-hero" aria-labelledby="account-title">
    <div>
      <p className="eyebrow">Personal account · {network}</p>
      <h1 id="account-title">{formatBalance(balance)}</h1>
      <div className="account-identity"><span className="identicon" aria-hidden="true" /> {account ? shorten(account) : "No account"}</div>
      {balance.status === "loaded" && balance.deployed === false && <p className="hero-note">Not yet deployed on chain · fund the address to activate it</p>}
    </div>
    <div className="hero-account-controls">
      <div className="hero-status"><span className="status-dot" /> Passkey verified</div>
      <div className="hero-session-actions">
        <button type="button" className="hero-button" onClick={onSwitch}>Switch account</button>
        <button type="button" className="hero-button" onClick={onLock}>Lock account</button>
      </div>
    </div>
  </section>;
}

function formatBalance(balance: BalanceView): string {
  if (balance.status === "loading") return "Loading…";
  if (balance.status === "error" || balance.eth === undefined) return "Balance unavailable";
  const [whole, fraction = ""] = balance.eth.split(".");
  const trimmed = fraction.replace(/0+$/, "").slice(0, 6);
  return `${trimmed ? `${whole}.${trimmed}` : whole} ETH`;
}

export function shorten(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
