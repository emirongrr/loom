import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

export type NotificationStatus = "pending" | "success" | "error" | "info";

export interface Notification {
  readonly id: string;
  readonly status: NotificationStatus;
  readonly title: string;
  readonly detail?: string;
  readonly href?: string;
  readonly linkLabel?: string;
}

interface NotificationsValue {
  notify(input: Omit<Notification, "id">): string;
  update(id: string, patch: Partial<Omit<Notification, "id">>): void;
  dismiss(id: string): void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);
const AUTO_DISMISS_MS = 8000;

export function NotificationsProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<readonly Notification[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  // Every scheduled dismissal owns a timer, and each one would otherwise still
  // be pending when this unmounts -- firing into a provider that no longer
  // exists. The map is the only thing that knows about them, so it clears them.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    setItems(current => current.filter(item => item.id !== id));
  }, [clearTimer]);

  const scheduleDismiss = useCallback((id: string, status: NotificationStatus) => {
    clearTimer(id);
    // Pending toasts stay until their outcome updates them; resolved ones fade.
    if (status === "pending") return;
    timers.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
  }, [clearTimer, dismiss]);

  const notify = useCallback((input: Omit<Notification, "id">) => {
    const id = crypto.randomUUID();
    setItems(current => [{ ...input, id }, ...current].slice(0, 5));
    scheduleDismiss(id, input.status);
    return id;
  }, [scheduleDismiss]);

  const update = useCallback((id: string, patch: Partial<Omit<Notification, "id">>) => {
    setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (patch.status) scheduleDismiss(id, patch.status);
  }, [scheduleDismiss]);

  const value = useMemo(() => ({ notify, update, dismiss }), [notify, update, dismiss]);

  return <NotificationsContext.Provider value={value}>
    {children}
    <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
      {items.map(item => <article key={item.id} className={`toast-card ${item.status}`}>
        <span className="toast-icon" aria-hidden="true">{iconFor(item.status)}</span>
        <div className="toast-body">
          <strong>{item.title}</strong>
          {item.detail && <p>{item.detail}</p>}
          {item.href && <a href={item.href} target="_blank" rel="noreferrer noopener">{item.linkLabel ?? "View"}</a>}
        </div>
        <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(item.id)}>×</button>
      </article>)}
    </div>
  </NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("NotificationsProvider is missing");
  return value;
}

function iconFor(status: NotificationStatus): string {
  switch (status) {
    case "pending": return "◴";
    case "success": return "✓";
    case "error": return "!";
    default: return "ℹ";
  }
}
