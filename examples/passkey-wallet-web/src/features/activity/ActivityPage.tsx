import type { AccountHandle } from "../../types";

export function ActivityPage({ account }: { readonly account: AccountHandle }) {
  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Account history</p><h1>Activity</h1><p>Activity for {account.label} appears only after a chain/indexing adapter is configured.</p></header>
    <section className="empty-state"><span aria-hidden="true">↻</span><h2>No verified activity loaded</h2><p>The wallet does not insert sample transfers or authority changes into your history.</p></section>
  </div>;
}
