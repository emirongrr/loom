import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: true } { return { failed: true }; }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Wallet screen failed safely", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <main className="wallet-landing lock-layout">
      <section className="landing-panel" role="alert">
        <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
        <p className="eyebrow">Display error</p>
        <h1>This screen could not be shown</h1>
        <p>Your wallets, guardians, and pending operations remain stored. No local record was deleted or replaced.</p>
        <div className="landing-actions">
          <button className="secondary" onClick={() => window.location.assign("/")}>Back to saved wallets</button>
          <button className="primary" onClick={() => window.location.reload()}>Reload screen</button>
        </div>
      </section>
    </main>;
  }
}
