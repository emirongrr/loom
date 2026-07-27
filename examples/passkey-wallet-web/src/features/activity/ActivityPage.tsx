import { useCallback, useEffect, useRef, useState } from "react";
import { useNetwork } from "../../config/NetworkContext";
import { transactionUrl } from "../../config/network";
import { readAccountActivity, type ActivityCursor } from "../wallet/activity";
import { nextEmptyPageCount, shouldAutoLoad, shouldPauseAutoLoad } from "./autoLoad";
import type { AccountHandle, ActivityItem } from "../../types";

export function ActivityPage({ account }: { readonly account: AccountHandle }) {
  const { config } = useNetwork();
  const [items, setItems] = useState<readonly ActivityItem[]>([]);
  const [cursor, setCursor] = useState<ActivityCursor | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "loading-more">("loading");
  const [unavailable, setUnavailable] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  // Guards against a stale response from a previous account/endpoint landing late.
  const generation = useRef(0);
  const emptyPages = useRef(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // Mirrors `cursor` so the observer callback can read it without re-subscribing.
  const cursorRef = useRef<ActivityCursor | null>(null);

  const loadFirstPage = useCallback(async () => {
    const current = ++generation.current;
    setPhase("loading");
    setItems([]);
    setCursor(null);
    cursorRef.current = null;
    setAutoPaused(false);
    emptyPages.current = 0;
    const result = await readAccountActivity(config, account.account);
    if (generation.current !== current) return;
    setItems(result.items);
    cursorRef.current = result.cursor;
    setCursor(result.cursor);
    setUnavailable(result.unavailable);
    setPhase("ready");
  }, [config, account.account]);

  useEffect(() => { void loadFirstPage(); }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    const current = generation.current;
    const active = cursorRef.current;
    if (!active) return;

    setPhase("loading-more");
    const result = await readAccountActivity(config, account.account, { cursor: active });
    if (generation.current !== current) return;

    // Merge by transaction hash so an entry seen on an earlier page is never
    // duplicated, and keep the whole list ordered as later pages arrive: the two
    // sources advance independently, so a later page can hold newer entries.
    let added = 0;
    setItems(previous => {
      const merged = new Map(previous.map(item => [item.id, item]));
      for (const item of result.items) if (!merged.has(item.id)) { merged.set(item.id, item); added += 1; }
      return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp);
    });

    emptyPages.current = nextEmptyPageCount(emptyPages.current, added);
    if (shouldPauseAutoLoad(emptyPages.current)) setAutoPaused(true);
    cursorRef.current = result.cursor;
    setCursor(result.cursor);
    setPhase("ready");
  }, [config, account.account]);

  // Auto-load as the end of the list comes into view. Kept in a ref so the
  // observer callback always sees current state without being re-created.
  const state = useRef({ phase, cursor, autoPaused, loadMore });
  state.current = { phase, cursor, autoPaused, loadMore };

  useEffect(() => {
    const target = sentinel.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      const intersecting = entries.some(entry => entry.isIntersecting);
      if (shouldAutoLoad(state.current, intersecting)) void state.current.loadMore();
    }, { rootMargin: "400px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [items.length]);

  const canObserve = typeof IntersectionObserver !== "undefined";
  const showManual = Boolean(cursor) && (autoPaused || !canObserve);

  return <div className="page-stack">
    <header className="page-title"><p className="eyebrow">Account history</p><h1>Activity</h1><p>Transfers and account operations for {account.label}, indexed by {hostOf(config.explorerUrl)}.</p></header>

    <section className="section-card">
      <div className="section-heading">
        <div><p className="eyebrow">Latest first</p><h2>Transactions{items.length > 0 && <span className="count-badge">{items.length}</span>}</h2></div>
        <button className="icon-button" onClick={() => void loadFirstPage()} disabled={phase !== "ready"} aria-label="Refresh activity"><span className={phase === "loading" ? "spin" : ""}>⟳</span></button>
      </div>

      {phase === "loading" && <p className="form-note">Reading account history…</p>}

      {phase !== "loading" && unavailable && <p className="callout warning">
        History is unavailable from the configured explorer, so it is unknown rather than empty. Change the explorer in Developer settings; your balances and the ability to transact are unaffected.
      </p>}

      {phase !== "loading" && !unavailable && items.length === 0 && <div className="empty-state">
        <span aria-hidden="true">↻</span><h2>No transactions yet</h2>
        <p>Once this account sends or receives its first transfer, it appears here.</p>
      </div>}

      {items.length > 0 && <>
        <div className="timeline">
          {items.map(item => <article key={item.id} className="timeline-item">
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
        </div>

        {/* Watched by the observer; also the live region for the paging state. */}
        <div ref={sentinel} className="load-more" aria-live="polite">
          {phase === "loading-more" && <p className="form-note"><span className="spin" aria-hidden="true">⟳</span> Loading older transactions…</p>}
          {phase === "ready" && showManual && <button className="secondary" onClick={() => { setAutoPaused(false); emptyPages.current = 0; void loadMore(); }}>Load older transactions</button>}
          {phase === "ready" && !cursor && <p className="form-note">End of indexed history.</p>}
        </div>
      </>}
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
