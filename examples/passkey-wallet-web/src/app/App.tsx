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
import type { WalletCreationRequest } from "../features/onboarding/WalletLanding";
import { authenticateBrowserAccount, deriveCreatedAccountHandle, loadWalletDeployment, migrateLegacyAccountHandles, registerBrowserPasskey } from "../features/onboarding/accountLifecycle";
import { prepareInitialGuardianSetup } from "../features/onboarding/initialGuardianSetup";
import { readVerifierCodeHash } from "../features/security/guardianClient";
import { createBrowserGuardianRoster } from "../storage/guardianRoster";
import { useNetwork } from "../config/NetworkContext";
import { parseAccountHandle } from "../storage/accountStore";
import { useAppServices } from "./AppServices";
import type { AccountHandle } from "../types";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { StopRecoveryPage } from "../features/recovery/StopRecoveryPage";
import { useAppNavigation } from "./useAppNavigation";
import { safeUserMessage } from "../domain/errors/appError";

export function App() {
  const services = useAppServices();
  const { config } = useNetwork();
  const { area, setArea, recoveryPath, recoveryPayerId, guardianInboundLink, theme, setTheme, openRecovery, closeRecovery } = useAppNavigation();
  const [accounts, setAccounts] = useState<readonly AccountHandle[]>([]);
  const [selected, setSelected] = useState<AccountHandle | null>(null);
  const [locked, setLocked] = useState<AccountHandle | null>(null);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void (async () => {
      try {
        let saved = await services.accounts.inspect();
        try {
          const legacyAccounts = await migrateLegacyAccountHandles(window.localStorage, { rpId: location.hostname, origin: location.origin });
          for (const legacy of [...legacyAccounts].reverse()) {
            if (!saved.accounts.some(account => account.id === legacy.id) && !(await services.accounts.isRemoved(legacy.id))) {
              await services.accounts.save(legacy);
            }
          }
          saved = await services.accounts.inspect();
        } catch { /* Legacy data stays untouched and is never surfaced as a separate onboarding flow. */ }
        setAccounts(saved.accounts);
        // A record this build cannot read is skipped rather than allowed to hide
        // the healthy ones, so say that it happened. Silently showing fewer
        // wallets than the user saved is the failure this avoids.
        if (saved.issues.length > 0) {
          setMessage(
            `${saved.issues.length} saved wallet ${saved.issues.length === 1 ? "record was" : "records were"} not readable and ${saved.issues.length === 1 ? "is" : "are"} not listed. Nothing was deleted.`
          );
        }
      } catch (error) {
        setMessage(safeUserMessage(error, "Saved wallets could not be read.", "storage"));
      } finally { setAccountsLoaded(true); }
    })();
  }, [services]);
  const refreshAccounts = async () => { const saved = await services.accounts.list(); setAccounts(saved); return saved; };
  const createAccount = async (request: WalletCreationRequest) => {
    setBusy(true); setMessage("");
    try {
      const deployment = await loadWalletDeployment();
      await services.runtime.verify(config, deployment);
      const initial = request.guardians ? await prepareInitialGuardianSetup({
        ...request.guardians,
        deployment,
        readVerifierCodeHash: verifier => readVerifierCodeHash(config, verifier, services.publicClients)
      }) : undefined;
      const passkey = await registerBrowserPasskey(request.label.trim());
      const handle = deriveCreatedAccountHandle({
        label: request.label,
        deployment,
        passkey,
        rpId: location.hostname,
        origin: location.origin,
        ...(initial ? { initialGuardians: { root: initial.set.root, threshold: initial.set.threshold } } : {})
      });
      if (initial) {
        // The encrypted private roster is written before the public handle. If
        // the second write fails, an unlisted orphan is safer than a protected
        // wallet whose guardian tree this device can no longer reconstruct.
        await createBrowserGuardianRoster().write(handle.id, {
          entries: initial.entries,
          version: Date.now(),
          pending: null
        });
      }
      await services.accounts.save(handle);
      await refreshAccounts();
      setLocked(handle); setArea("home");
    } catch (error) { setMessage(safeUserMessage(error, "Wallet could not be created.", "preparation")); }
    finally { setBusy(false); }
  };
  const importAccount = async (text: string) => {
    setBusy(true); setMessage("");
    try {
      const handle = parseAccountHandle(JSON.parse(text));
      await services.accounts.save(handle);
      await refreshAccounts();
      setLocked(handle); setArea("home");
    } catch (error) { setMessage(safeUserMessage(error, "Wallet handle could not be restored.", "storage")); }
    finally { setBusy(false); }
  };
  const unlockAccount = async (account: AccountHandle) => {
    setBusy(true); setMessage("");
    try {
      await authenticateBrowserAccount(account);
      setSelected(account); setLocked(null); setArea(guardianInboundLink ? "guardian" : "home");
    } catch (error) { setMessage(safeUserMessage(error, "Passkey authentication failed.", "passkey")); }
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
  const saveRecoveredAccount = async (handle: AccountHandle) => {
    if (handle.kind !== "recovered") throw new Error("Recovery produced an invalid wallet handle.");
    await services.accounts.linkRecovered(handle);
    await refreshAccounts();
  };
  if (!accountsLoaded) return <main className="wallet-landing"><section className="landing-panel"><p>Loading saved wallets…</p></section></main>;
  if (recoveryPath === STOP_RECOVERY_PATH && selected) {
    return <><StopRecoveryPage handle={selected} onClose={closeRecovery} /><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  }
  // Reached only with an account open, since stopping a recovery is something
  // an owner does about their own account. Visiting the path without one falls
  // through to the lock screen rather than to the page for recovering someone
  // else's account, which answers a different question entirely.
  if (recoveryPath && recoveryPath !== STOP_RECOVERY_PATH) return <><RecoveryPage path={recoveryPath} accounts={accounts} {...(recoveryPayerId ? { preferredGasPayerId: recoveryPayerId } : {})} sourceWalletOpen={Boolean(selected && selected.id === recoveryPayerId)} onClose={closeRecovery} onNavigate={path => openRecovery(path)} onRecovered={saveRecoveredAccount} /><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  if (!selected && locked) return <><WalletLock account={locked} busy={busy} message={message} onUnlock={() => unlockAccount(locked)} onSwitch={() => { setLocked(null); setMessage(""); }} /><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  if (!selected) return <><WalletLanding accounts={accounts} busy={busy} message={message} onCreate={createAccount} onImport={importAccount} onClearMessage={() => setMessage("")} onOpen={unlockAccount} onRemove={removeAccount} onGuardianRecover={() => openRecovery()} /><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
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
      lockAccount,
      () => openRecovery("/recover", selected.id),
      guardianInboundLink,
      () => openRecovery(STOP_RECOVERY_PATH, selected.id)
    )}</main>
    <button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button>
    <nav className="bottom-nav" aria-label="Mobile navigation">{primaryNavigation.map(item => <NavButton key={item.id} item={item} current={area} onClick={setArea} />)}</nav>
  </div>;
}

function NavButton({ item, current, onClick }: { item: { id: NavigationArea; label: string; icon: string }; current: NavigationArea; onClick(area: NavigationArea): void }) {
  return <button className={current === item.id ? "nav-item active" : "nav-item"} aria-current={current === item.id ? "page" : undefined} onClick={() => onClick(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>;
}

function renderArea(area: NavigationArea, navigate: (area: NavigationArea) => void, account: AccountHandle, switchAccount: () => void, lockAccount: () => void, openRecovery: () => void, guardianInboundLink: string, stopRecovery: () => void) {
  switch (area) {
    case "home": return <HomePage account={account} onNavigate={navigate} onSwitch={switchAccount} onLock={lockAccount} onStopRecovery={stopRecovery} />;
    case "activity": return <ActivityPage account={account} />;
    case "apps": return <AppsPage account={account} />;
    case "security": return <SecurityPage account={account} onGuardian={() => navigate("guardian")} onRecovery={openRecovery} />;
    case "guardian": return <GuardianWorkspace account={account} inboundLink={guardianInboundLink} />;
    case "developer": return <DeveloperSettings />;
  }
}

/** Where the warning on the wallet sends an owner who wants this stopped. */
export const STOP_RECOVERY_PATH = "/recover/stop";
