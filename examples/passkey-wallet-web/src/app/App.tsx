import { useEffect, useState } from "react";
import type { NavigationArea } from "../types";
import { primaryNavigation } from "./navigation";
import { HomePage } from "../features/home/HomePage";
import { ActivityPage } from "../features/activity/ActivityPage";
import { AppsPage } from "../features/apps/AppsPage";
import { SecurityPage } from "../features/security/SecurityPage";
import { GuardianWorkspace } from "../features/guardians/GuardianWorkspace";
import { DeveloperSettings } from "../features/developer/DeveloperSettings";
import { WalletLanding, WalletLock } from "../features/onboarding/WalletLanding";
import { authenticateBrowserAccount, deriveCreatedAccountHandle, loadWalletDeployment, migrateLegacyAccountHandles, registerBrowserPasskey } from "../features/onboarding/accountLifecycle";
import { parseAccountHandle } from "../storage/accountStore";
import { useAppServices } from "./AppServices";
import type { AccountHandle } from "../types";
import { useNetwork } from "../config/NetworkContext";

export function App() {
  const services = useAppServices();
  const { config } = useNetwork();
  const [area, setArea] = useState<NavigationArea>(() => routeFromLocation());
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("loom.theme") === "dark" ? "dark" : "light");
  const [accounts, setAccounts] = useState<readonly AccountHandle[]>([]);
  const [selected, setSelected] = useState<AccountHandle | null>(null);
  const [locked, setLocked] = useState<AccountHandle | null>(null);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("loom.theme", theme); }, [theme]);
  useEffect(() => { history.replaceState(null, "", area === "home" ? "/" : `/${area}`); window.scrollTo({ top: 0, behavior: "smooth" }); }, [area]);
  useEffect(() => {
    void (async () => {
      try {
        let saved = await services.accounts.list();
        try {
          const legacyAccounts = await migrateLegacyAccountHandles(window.localStorage, { rpId: location.hostname, origin: location.origin });
          for (const legacy of [...legacyAccounts].reverse()) {
            if (!saved.some(account => account.id === legacy.id) && !(await services.accounts.isRemoved(legacy.id))) {
              await services.accounts.save(legacy);
            }
          }
          saved = await services.accounts.list();
        } catch { /* Legacy data stays untouched and is never surfaced as a separate onboarding flow. */ }
        setAccounts(saved);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Saved wallets could not be read");
      } finally { setAccountsLoaded(true); }
    })();
  }, [services]);
  const refreshAccounts = async () => { const saved = await services.accounts.list(); setAccounts(saved); return saved; };
  const createAccount = async (label: string) => {
    setBusy(true); setMessage("");
    try {
      const deployment = await loadWalletDeployment();
      await services.runtime.verify(config, deployment);
      const passkey = await registerBrowserPasskey(label.trim());
      const handle = deriveCreatedAccountHandle({ label, deployment, passkey, rpId: location.hostname, origin: location.origin });
      await services.accounts.save(handle);
      await refreshAccounts();
      setLocked(handle); setArea("home");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Wallet could not be created"); }
    finally { setBusy(false); }
  };
  const importAccount = async (text: string) => {
    setBusy(true); setMessage("");
    try {
      const handle = parseAccountHandle(JSON.parse(text));
      await services.accounts.save(handle);
      await refreshAccounts();
      setLocked(handle); setArea("home");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Wallet handle could not be restored"); }
    finally { setBusy(false); }
  };
  const unlockAccount = async (account: AccountHandle) => {
    setBusy(true); setMessage("");
    try {
      await authenticateBrowserAccount(account);
      setSelected(account); setLocked(null); setArea("home");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Passkey authentication failed"); }
    finally { setBusy(false); }
  };
  const removeAccount = async (account: AccountHandle) => {
    setBusy(true); setMessage("");
    try {
      const removed = await services.accounts.remove(account.id);
      await refreshAccounts();
      setMessage(removed ? `${account.label} was removed from Saved Wallets.` : `${account.label} is no longer saved.`);
    } catch (error) {
      setMessage("Saved wallet could not be removed. Try again.");
      throw error;
    }
    finally { setBusy(false); }
  };
  const switchAccount = () => { setSelected(null); setLocked(null); setArea("home"); setMessage(""); };
  const lockAccount = () => { setSelected(null); setLocked(selected); setArea("home"); setMessage(""); };
  if (!accountsLoaded) return <main className="wallet-landing"><section className="landing-panel"><p>Loading saved wallets…</p></section></main>;
  if (!selected && locked) return <><WalletLock account={locked} busy={busy} message={message} onUnlock={() => unlockAccount(locked)} onSwitch={() => { setLocked(null); setMessage(""); }} /><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  if (!selected) return <><WalletLanding accounts={accounts} busy={busy} message={message} onCreate={createAccount} onImport={importAccount} onClearMessage={() => setMessage("")} onOpen={unlockAccount} onRemove={removeAccount} /><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setArea("home")} aria-label="Loom wallet home"><span className="brand-mark">L</span><span>Loom</span></button>
      <nav aria-label="Primary navigation">{primaryNavigation.map(item => <NavButton key={item.id} item={item} current={area} onClick={setArea} />)}</nav>
      <div className="sidebar-divider" />
      <button className={area === "guardian" ? "nav-item active" : "nav-item"} onClick={() => setArea("guardian")}><span>◉</span>Accounts I protect</button>
      <div className="sidebar-spacer" />
      <button className={area === "developer" ? "nav-item active" : "nav-item"} onClick={() => setArea("developer")}><span>⚙</span>Developer</button>
      <div className="network-card"><span className="status-dot" /><div><strong>{selected.label}</strong><span>Chain {selected.chainId}</span></div></div>
      <div className="sidebar-session-actions"><button onClick={switchAccount}>Switch account</button><button onClick={lockAccount}>Lock account</button></div>
    </aside>
    <header className="mobile-header"><button className="brand" onClick={() => setArea("home")}><span className="brand-mark">L</span><span>Loom</span></button><button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></header>
    <main id="main-content">{renderArea(
      area,
      setArea,
      selected,
      switchAccount,
      lockAccount
    )}</main>
    <button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button>
    <nav className="bottom-nav" aria-label="Mobile navigation">{primaryNavigation.map(item => <NavButton key={item.id} item={item} current={area} onClick={setArea} />)}</nav>
  </div>;
}

function NavButton({ item, current, onClick }: { item: { id: NavigationArea; label: string; icon: string }; current: NavigationArea; onClick(area: NavigationArea): void }) {
  return <button className={current === item.id ? "nav-item active" : "nav-item"} aria-current={current === item.id ? "page" : undefined} onClick={() => onClick(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>;
}

function renderArea(area: NavigationArea, navigate: (area: NavigationArea) => void, account: AccountHandle, switchAccount: () => void, lockAccount: () => void) {
  switch (area) {
    case "home": return <HomePage account={account} onNavigate={navigate} onSwitch={switchAccount} onLock={lockAccount} />;
    case "activity": return <ActivityPage account={account} />;
    case "apps": return <AppsPage account={account} />;
    case "security": return <SecurityPage account={account} onGuardian={() => navigate("guardian")} />;
    case "guardian": return <GuardianWorkspace />;
    case "developer": return <DeveloperSettings />;
  }
}

function routeFromLocation(): NavigationArea {
  const value = location.pathname.slice(1) as NavigationArea;
  return ["activity", "apps", "security", "guardian", "developer"].includes(value) ? value : "home";
}
