import type { PropsWithChildren } from "react";

export function StatusPanel({ children, tone = "info", id, busy = false }: PropsWithChildren<{
  id?: string;
  tone?: "info" | "warning" | "success";
  busy?: boolean;
}>) {
  return <div id={id} className={`callout${tone === "info" ? "" : ` ${tone}`}`} role="status" aria-live="polite" aria-busy={busy}>
    {children}
  </div>;
}

export function AdvancedDetails({ children }: PropsWithChildren) {
  return <details><summary>Advanced details</summary>{children}</details>;
}
