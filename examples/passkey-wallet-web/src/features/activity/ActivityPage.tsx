import { useCallback, useEffect, useState } from "react";
import { useNetwork } from "../../config/NetworkContext";
import { transactionUrl } from "../../config/network";
import { readAccountActivity } from "../wallet/activity";
import type { AccountHandle, ActivityItem } from "../../types";

type View =
  | { status: "loading" }
  | { status: "ready"; items: readonly ActivityItem[]; unavailable: boolean };

export function ActivityPage({ account }: { readonly account: AccountHandle }) {
  const { config } = useNetwork();
  const [view, setView] = useState<View>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setView({ status: "loading" });
    setRefreshing(true);
    try {
      const result = await readAccountActivity(config, account.account);
      setView({ status: "ready", items: result.items, unavailable: result.unavailable });
    } finally { setRefreshing(false); }
  }, [config, account.account]);

  useEffect(() => { void load(); }, [load]);

  return <div className="page-stack">
    <header className="page-title"><p className="eyebrow">Account history</p><h1>Activity</h1><p>Transfers and account operations for {account.label}, indexed by {hostOf(config.explorerUrl)}.</p></header>

    <section className="section-card">
      <div className="section-heading">
        <div><p className="eyebrow">Latest first</p><h2>Transactions</h2></div>
        <button className="icon-button" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh activity"><span className={refreshing ? "spin" : ""}>⟳</span></button>
      </div>

      {view.status === "loading" && <p className="form-note">Reading account history…</p>}

      {view.status === "ready" && view.unavailable && <p className="callout warning">
        History is unavailable from the configured explorer, so it is unknown rather than empty. Change the explorer in Developer settings; your balances and the ability to transact are unaffected.
      </p>}

      {view.status === "ready" && !view.unavailable && view.items.length === 0 && <div className="empty-state">
        <span aria-hidden="true">↻</span><h2>No transactions yet</h2>
        <p>Once this account sends or receives its first transfer, it appears here.</p>
      </div>}

      {view.status === "ready" && view.items.length > 0 && <div className="timeline">
        {view.items.map(item => <article key={item.id} className="timeline-item">
          <span className={`timeline-dot ${item.status}`} aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
            <time dateTime={new Date(item.timestamp).toISOString()}>{formatWhen(item.timestamp)}</time>
          </div>
          <div className="timeline-side">
            {item.amount && <strong className={amountClass(item)}>{amountPrefix(item)}{item.amount}</strong>}
            <span className={`pill ${item.status}`}>{item.status}</span>
            <a className="text-button" href={transactionUrl(config, item.hash)} target="_blank" rel="noreferrer noopener">Explorer</a>
          </div>
        </article>)}
      </div>}
    </section>

    <p className="form-note">A block explorer index can omit or mislabel history. It is shown as history only — never as account authority, and never as the source of your balance.</p>
  </div>;
}

function amountClass(item: ActivityItem): string {
  if (item.status === "failed") return "amount-failed";
  return item.direction === "received" ? "amount-in" : item.direction === "self" ? "" : "amount-out";
}

function amountPrefix(item: ActivityItem): string {
  if (item.status === "failed" || item.direction === "self") return "";
  return item.direction === "received" ? "+" : "−";
}

function formatWhen(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function hostOf(url: string): string { return url.replace(/^https?:\/\//, "").split("/")[0] ?? url; }
