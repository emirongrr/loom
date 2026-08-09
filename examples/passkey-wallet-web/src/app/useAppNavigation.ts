import { useEffect, useState } from "react";
import type { NavigationArea } from "../types";

export function useAppNavigation() {
  const [area, setArea] = useState<NavigationArea>(() => routeFromLocation());
  const [recoveryPath, setRecoveryPath] = useState<string | null>(() => location.pathname.startsWith("/recover") ? location.pathname : null);
  const [recoveryPayerId, setRecoveryPayerId] = useState<string | null>(() => recoveryPayerFromHistory());
  const [guardianInboundLink] = useState(() => location.pathname === "/guardian" && location.hash.includes("cap=") ? location.href : "");
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("loom.theme") === "dark" ? "dark" : "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("loom.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!recoveryPath) history.replaceState(null, "", area === "home" ? "/" : `/${area}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [area, recoveryPath]);
  useEffect(() => {
    const onPopState = () => {
      setRecoveryPath(location.pathname.startsWith("/recover") ? location.pathname : null);
      setRecoveryPayerId(recoveryPayerFromHistory());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openRecovery = (path = "/recover", payerId: string | null = recoveryPayerId) => {
    history.pushState(payerId ? { recoveryPayerId: payerId } : null, "", path);
    setRecoveryPayerId(payerId);
    setRecoveryPath(path);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const closeRecovery = () => {
    history.pushState(null, "", "/");
    setRecoveryPayerId(null);
    setRecoveryPath(null);
    setArea("home");
  };

  return { area, setArea, recoveryPath, recoveryPayerId, guardianInboundLink, theme, setTheme, openRecovery, closeRecovery } as const;
}

function routeFromLocation(): NavigationArea {
  const value = location.pathname.slice(1) as NavigationArea;
  return ["activity", "apps", "security", "guardian", "developer"].includes(value) ? value : "home";
}

function recoveryPayerFromHistory(): string | null {
  const value: unknown = history.state;
  if (!value || typeof value !== "object") return null;
  const payerId = (value as Record<string, unknown>).recoveryPayerId;
  return typeof payerId === "string" && payerId.length > 0 && payerId.length <= 100 ? payerId : null;
}
