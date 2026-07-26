import type { AccountHandle } from "../../types";

export function AppsPage({ account }: { readonly account: AccountHandle }) {
  return <div className="page-stack"><header className="page-title"><p className="eyebrow">Connected applications</p><h1>Apps & sessions</h1><p>Sessions for {account.label} are shown only after verified account state is available.</p></header>
    <section className="empty-state"><span aria-hidden="true">◇</span><h2>No verified sessions loaded</h2><p>No sample application permissions are presented as real account authority.</p></section>
  </div>;
}
