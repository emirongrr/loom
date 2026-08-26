import { lazy, Suspense, useEffect, useState, type PropsWithChildren } from "react";
import type { NavigationArea } from "../types";
import { primaryNavigation } from "./navigation";
import { Dialog } from "../components/Dialog";
import { HomePage } from "../features/home/HomePage";
import { ActivityPage } from "../features/activity/ActivityPage";
import { AppsPage } from "../features/apps/AppsPage";
import { DeveloperSettings } from "../features/developer/DeveloperSettings";
import { WalletLanding, WalletLock } from "../features/onboarding/WalletLanding";
import type { WalletCreationRequest } from "../features/onboarding/WalletLanding";
import { authenticateBrowserAccount, deriveCreatedAccountHandle, loadWalletDeployment, migrateLegacyAccountHandles, registerBrowserPasskey } from "../features/onboarding/accountLifecycle";
import { prepareInitialGuardianSetup } from "../features/onboarding/initialGuardianSetup";
import { readVerifierCodeHash } from "../features/security/guardianClient";
import { useNetwork } from "../config/NetworkContext";
import { useAppServices } from "./AppServices";
import type { AccountHandle } from "../types";
import { findWalletsByPasskey } from "../features/onboarding/findWalletsByPasskey";
import { assertAnyPasskey } from "../features/wallet/webauthn";
import { useAppNavigation } from "./useAppNavigation";
import { safeUserMessage } from "../domain/errors/appError";

/**
 * Recovery, stopping a recovery, the security screen and the guardian workspace
 * are each reached by their own route and by no other path. Loaded with the
 * rest, they made someone opening the wallet to read a balance download the
 * whole of both flows first.
 */
const SecurityPage = lazy(() => import("../features/security/SecurityPage").then(module => ({ default: module.SecurityPage })));
const GuardianWorkspace = lazy(() => import("../features/guardians/GuardianWorkspace").then(module => ({ default: module.GuardianWorkspace })));
const RecoveryPage = lazy(() => import("../features/recovery/RecoveryPage").then(module => ({ default: module.RecoveryPage })));
const StopRecoveryPage = lazy(() => import("../features/recovery/StopRecoveryPage").then(module => ({ default: module.StopRecoveryPage })));

/**
 * What a route shows while its chunk arrives. Deliberately plain: a spinner
 * that appears for a few hundred milliseconds and then vanishes reads as
 * something going wrong more often than it reads as progress.
 */
function RouteChunk({ children }: PropsWithChildren) {
  return <Suspense fallback={<main className="wallet-landing"><section className="landing-panel"><p>Opening…</p></section></main>}>{children}</Suspense>;
}

/** The endpoint's host, for saying which one failed without printing a key. */
function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return endpoint; }
}

/**
 * Every validator a key could have been published by.
 *
 * The deployment's own, plus each one a recovery deployed -- read from the
 * factory's own announcements, which is one query rather than a scan of the
 * chain for anything that ever emitted a key. A recovered account's key lives
 * on the validator its recovery installed, so leaving those out is what made a
 * recovered wallet unfindable by its own passkey.
 *
 * A factory that cannot be read yields the profile's validator alone: fewer
 * places to look, not a failure.
 */
async function validatorsToSearch(
  deployment: Awaited<ReturnType<typeof loadWalletDeployment>>,
  client: { getLogs: (request: never) => Promise<readonly { readonly data: `0x${string}` }[]> }
): Promise<readonly `0x${string}`[]> {
  const factory = deployment.recoveryValidatorProvisioner?.address;
  if (!factory) return [deployment.validator];
  try {
    const logs = await client.getLogs({
      address: factory,
      fromBlock: 0n,
      toBlock: "latest",
      event: RECOVERY_VALIDATOR_DEPLOYED
    } as never);
    const deployed = logs.map(log => `0x${log.data.slice(26, 66)}` as `0x${string}`);
    return [deployment.validator, ...new Set(deployed)];
  } catch {
    return [deployment.validator];
  }
}

const RECOVERY_VALIDATOR_DEPLOYED = {
  type: "event",
  name: "RecoveryValidatorDeployed",
  inputs: [
    { name: "account", type: "address", indexed: true },
    { name: "recoveryNonce", type: "uint64", indexed: true },
    { name: "initDataHash", type: "bytes32", indexed: true },
    { name: "validator", type: "address" },
    { name: "newGuardianRoot", type: "bytes32" },
    { name: "newGuardianThreshold", type: "uint8" }
  ]
} as const;


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
  /** A passkey's account, shown for confirmation before it is saved. */
  const [foundByPasskey, setFoundByPasskey] = useState<{
    readonly account: `0x${string}`;
    readonly validator: `0x${string}`;
    readonly publicKey: { readonly x: `0x${string}`; readonly y: `0x${string}` };
    readonly credentialId: `0x${string}`;
    readonly chainId: number;
    readonly deployed: boolean;
    readonly alreadySaved: string | null;
  } | null>(null);
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
        await services.guardianRoster.write(handle.id, {
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
  /**
   * Bring back a wallet this browser has never heard of, using the passkey.
   *
   * Nothing is stored in advance and no server is asked. The account published
   * its public key when it installed its validator; the assertion proves which
   * key signed; the two together name the account. A private window, a new
   * browser, or a cleared one can all get back in with the passkey alone.
   */
  const findByPasskey = async () => {
    setBusy(true);
    setMessage("");
    try {
      // Asked first, before anything is awaited. `navigator.credentials.get`
      // needs the transient activation the click granted, and awaiting a fetch
      // ahead of it spends that activation -- the browser then rejects the call
      // without ever showing its picker, which looks like nothing happening.
      const assertion = await assertAnyPasskey();
      if (!assertion) { setMessage("No passkey was offered, so there is nothing to look up."); return; }
      const deployment = await loadWalletDeployment();
      const client = services.publicClients.forEndpoint(config.rpcUrl);
      const result = await findWalletsByPasskey({
        validators: await validatorsToSearch(deployment, client as never),
        assertion,
        rpId: window.location.hostname,
        origin: window.location.origin,
        reader: {
          getBlockNumber: () => client.getBlockNumber(),
          getLogs: request => client.getLogs({
            address: [...request.address],
            fromBlock: request.fromBlock,
            toBlock: request.toBlock,
            ...(request.topics.length > 0 ? { topics: request.topics as [`0x${string}`] } : {})
          }) as never
        }
      });
      if (result.unavailable) { setMessage(`The chain could not be searched: ${result.unavailable}`); return; }
      if (!result.found) {
        setMessage("That passkey does not match any account published on this chain. If the wallet was never used on chain, restore it from an exported handle instead.");
        return;
      }
      const existing = accounts.find(candidate => candidate.account.toLowerCase() === result.found!.account.toLowerCase());
      const code = await client.getCode({ address: result.found.account }).catch(() => undefined);
      // Shown before anything is written down. Which account a passkey opens is
      // the one thing the reader cannot check for themselves, and saving first
      // makes the answer something they have to undo rather than accept.
      setFoundByPasskey({
        account: result.found.account,
        validator: result.found.validator,
        publicKey: { x: result.found.x, y: result.found.y },
        credentialId: assertion.credentialId,
        chainId: deployment.chainId,
        deployed: Boolean(code && code !== "0x"),
        alreadySaved: existing?.label ?? null
      });
      return;
    } catch (issue) {
      // A network-level failure arrives as a bare "Failed to fetch", which names
      // neither the endpoint that failed nor anything to do about it. The
      // endpoint is configurable, so saying which one it was is the difference
      // between a dead end and a setting to change.
      const reason = issue instanceof Error ? issue.message : "";
      setMessage(/failed to fetch|network|load failed/iu.test(reason)
        ? `${hostOf(config.rpcUrl)} could not be reached, so the chain could not be searched. Check the RPC endpoint in Developer settings.`
        : reason || "The passkey could not be used.");
    } finally { setBusy(false); }
  };

  const saveFoundWallet = async () => {
    if (!foundByPasskey) return;
    setBusy(true);
    try {
      await services.accounts.save({
        version: 1,
        kind: "recovered",
        id: `passkey:${foundByPasskey.account.toLowerCase()}`,
        label: "Recovered wallet",
        account: foundByPasskey.account,
        chainId: foundByPasskey.chainId,
        credentialId: foundByPasskey.credentialId,
        publicKey: foundByPasskey.publicKey,
        rpId: window.location.hostname,
        origin: window.location.origin,
        // The validator that published this key, not the profile's. A recovered
        // account is controlled by the validator its recovery installed, and
        // signing against the profile's would fail as AA24.
        validator: foundByPasskey.validator
      });
      await refreshAccounts();
      setFoundByPasskey(null);
      setMessage("Wallet saved. Open it, or search again with another passkey.");
    } catch (issue) {
      setMessage(issue instanceof Error ? issue.message : "The wallet could not be saved.");
    } finally { setBusy(false); }
  };

  if (!accountsLoaded) return <main className="wallet-landing"><section className="landing-panel"><p>Loading saved wallets…</p></section></main>;
  if (recoveryPath === STOP_RECOVERY_PATH && selected) {
    return <><RouteChunk><StopRecoveryPage handle={selected} onClose={closeRecovery} /></RouteChunk><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  }
  // Reached only with an account open, since stopping a recovery is something
  // an owner does about their own account. Visiting the path without one falls
  // through to the lock screen rather than to the page for recovering someone
  // else's account, which answers a different question entirely.
  if (recoveryPath && recoveryPath !== STOP_RECOVERY_PATH) return <><RouteChunk><RecoveryPage path={recoveryPath} accounts={accounts} {...(recoveryPayerId ? { preferredGasPayerId: recoveryPayerId } : {})} sourceWalletOpen={Boolean(selected && selected.id === recoveryPayerId)} onClose={closeRecovery} onNavigate={path => openRecovery(path)} onRecovered={saveRecoveredAccount} /></RouteChunk><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  if (!selected && locked) return <><WalletLock account={locked} busy={busy} message={message} onUnlock={() => unlockAccount(locked)} onSwitch={() => { setLocked(null); setMessage(""); }} /><button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
  if (!selected) return <><WalletLanding accounts={accounts} busy={busy} message={message} onCreate={createAccount} onClearMessage={() => setMessage("")} onOpen={unlockAccount} onRemove={removeAccount} onGuardianRecover={() => openRecovery()} onFindByPasskey={findByPasskey} />
    {foundByPasskey && <Dialog label="Wallet found" busy={busy} onClose={() => setFoundByPasskey(null)}>
      <p className="eyebrow">This passkey opens</p>
      <h2 className="breakable">{foundByPasskey.account}</h2>
      <div className="permission-grid">
        <div><span>Chain</span><strong>{foundByPasskey.chainId}</strong></div>
        <div><span>On chain</span><strong>{foundByPasskey.deployed ? "Created" : "Not created yet"}</strong></div>
      </div>
      {/* The address is what the reader cannot work out for themselves, so it
          is stated before anything is written down rather than after. */}
      {foundByPasskey.alreadySaved
        ? <>
          <p className="callout">Already saved here as <strong>{foundByPasskey.alreadySaved}</strong>. Nothing needs adding.</p>
          <div className="landing-actions">
            <button className="primary" onClick={() => setFoundByPasskey(null)}>Close</button>
          </div>
        </>
        : <>
          <p className="form-note">Saving it puts the wallet in your list on this device. Nothing is published and no one is told.</p>
          <div className="landing-actions">
            <button className="secondary" disabled={busy} onClick={() => setFoundByPasskey(null)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void saveFoundWallet()}>Save this wallet</button>
          </div>
        </>}
    </Dialog>}<button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button></>;
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
    <main id="main-content"><RouteChunk>{renderArea(
      area,
      setArea,
      selected,
      switchAccount,
      lockAccount,
      () => openRecovery("/recover", selected.id),
      guardianInboundLink,
      () => openRecovery(STOP_RECOVERY_PATH, selected.id),
      () => { void refreshAccounts(); }
    )}</RouteChunk></main>
    <button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button>
    <nav className="bottom-nav" aria-label="Mobile navigation">{primaryNavigation.map(item => <NavButton key={item.id} item={item} current={area} onClick={setArea} />)}</nav>
  </div>;
}

function NavButton({ item, current, onClick }: { item: { id: NavigationArea; label: string; icon: string }; current: NavigationArea; onClick(area: NavigationArea): void }) {
  return <button className={current === item.id ? "nav-item active" : "nav-item"} aria-current={current === item.id ? "page" : undefined} onClick={() => onClick(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>;
}

function renderArea(area: NavigationArea, navigate: (area: NavigationArea) => void, account: AccountHandle, switchAccount: () => void, lockAccount: () => void, openRecovery: () => void, guardianInboundLink: string, stopRecovery: () => void, onRenamed: () => void) {
  switch (area) {
    case "home": return <HomePage account={account} onNavigate={navigate} onSwitch={switchAccount} onLock={lockAccount} onStopRecovery={stopRecovery} />;
    case "activity": return <ActivityPage account={account} />;
    case "apps": return <AppsPage account={account} />;
    case "security": return <SecurityPage account={account} onGuardian={() => navigate("guardian")} onRecovery={openRecovery} />;
    case "guardian": return <GuardianWorkspace account={account} inboundLink={guardianInboundLink} />;
    case "developer": return <DeveloperSettings account={account} onRenamed={onRenamed} />;
  }
}

/** Where the warning on the wallet sends an owner who wants this stopped. */
export const STOP_RECOVERY_PATH = "/recover/stop";
