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
import { authenticateBrowserAccount, backupObservation, credentialBackupState, deriveCreatedAccountHandle, loadWalletDeployment, registerBrowserPasskey, updateBrowserPasskeyLabel } from "../features/onboarding/accountLifecycle";
import { prepareInitialGuardianSetup } from "../features/onboarding/initialGuardianSetup";
import { readVerifierCodeHash } from "../features/security/guardianClient";
import { useNetwork } from "../config/NetworkContext";
import { LoomAccountAbi, P256ValidatorAbi } from "@loom/core/abi";
import type { Hex } from "@loom/core";
import { keccak256, sha256, stringToHex } from "viem";
import { createRpcStateTransport, discoverPasskeyAccount } from "@loom/sdk";
import { hexFromBytes } from "../services/webauthn/encoding.ts";
import { useAppServices } from "./AppServices";
import type { AccountHandle } from "../types";
import { assertAnyPasskey } from "../features/wallet/webauthn";
import { useAppNavigation } from "./useAppNavigation";
import { safeUserMessage } from "../domain/errors/appError";
import { readAccountControl } from "../features/wallet/accountControl";
import { createAccountHandle } from "../features/onboarding/passkeyUserHandle.ts";
import { activateAccount } from "../features/wallet/activate.ts";

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
    readonly accountHandle: Hex;
    readonly passkeyBackup: NonNullable<AccountHandle["passkeyBackup"]>;
    readonly deployed: boolean;
    readonly alreadySaved: string | null;
  } | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const saved = await services.accounts.inspect();
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
      const accountHandle = createAccountHandle();
      const passkey = await registerBrowserPasskey(
        request.label.trim(), accountHandle, deployment.chainId, deployment.factory
      );
      const handle = deriveCreatedAccountHandle({
        label: request.label,
        deployment,
        passkey,
        rpId: location.hostname,
        origin: location.origin,
        ...(initial ? { initialGuardians: { root: initial.set.root, threshold: initial.set.threshold } } : {})
      });
      await updateBrowserPasskeyLabel({
        userHandle: passkey.userHandle,
        label: handle.label,
        account: handle.account,
        chainId: handle.chainId
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
      if (deployment.onboarding?.activation === "sponsored") {
        if (!config.relayUrl) {
          setLocked(handle); setArea("home");
          setMessage("Wallet saved, but this deployment requires a sponsor relay before it can be restored on another device. Configure the relay and activate it from Home.");
          return;
        }
        try {
          await activateAccount({
            config,
            account: handle,
            deployment,
            pendingOperations: services.pendingOperations,
            runtime: services.runtime,
            publicClients: services.publicClients,
            submission: "sponsored-private"
          });
          setSelected(handle); setLocked(null); setArea("home");
          setMessage("Wallet created and privately activated. Its synced passkey can now discover it on another device.");
          return;
        } catch (activationError) {
          setLocked(handle); setArea("home");
          setMessage(`Wallet and passkey were saved, but sponsored activation did not complete: ${safeUserMessage(activationError, "Try activation again from Home.", "submission")}`);
          return;
        }
      }
      setLocked(handle); setArea("home");
    } catch (error) { setMessage(safeUserMessage(error, "Wallet could not be created.", "preparation")); }
    finally { setBusy(false); }
  };
  const unlockAccount = async (account: AccountHandle) => {
    setBusy(true); setMessage("");
    try {
      const passkeyBackup = await authenticateBrowserAccount(account);
      const deployment = await loadWalletDeployment();
      await services.runtime.verify(config, deployment);
      if (account.chainId !== deployment.chainId) {
        throw new Error(`This saved wallet belongs to chain ${account.chainId}, but the wallet is connected to chain ${deployment.chainId}.`);
      }
      const validator = account.kind === "recovered" ? account.validator : deployment.validator;
      const client = services.publicClients.forEndpoint(config.rpcUrl);
      const code = await client.getCode({ address: account.account });
      const control = await readAccountControl({
        account: account.account,
        validator,
        publicKey: {
          ...account.publicKey,
          rpIdHash: sha256(stringToHex(account.rpId)),
          originHash: keccak256(stringToHex(account.origin))
        },
        deployed: Boolean(code && code !== "0x"),
        isModuleInstalled: async check => await client.readContract({
          address: check.account,
          abi: LoomAccountAbi,
          functionName: "isModuleInstalled",
          args: [check.moduleTypeId, check.module, "0x"]
        }) as boolean,
        readPublicKey: async check => await client.readContract({
          address: check.validator,
          abi: P256ValidatorAbi,
          functionName: "publicKeys",
          args: [check.account]
        }) as readonly [Hex, Hex, Hex, Hex]
      });
      if (control.kind === "superseded") {
        throw new Error("This saved passkey no longer controls the account. Find it with the recovery passkey instead.");
      }
      if (control.kind === "unreadable") {
        throw new Error("The account's current key could not be verified, so it was not opened for signing.");
      }
      const refreshed = { ...account, passkeyBackup } as AccountHandle;
      await services.accounts.save(refreshed);
      await refreshAccounts();
      setSelected(refreshed); setLocked(null); setArea(guardianInboundLink ? "guardian" : "home");
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
   * Nothing is stored in this browser and no server is asked. The credential's
   * random wallet id locates one factory account; a fresh assertion is then
   * verified against that account's live validator key before it is offered.
   */
  /** What both routes end at: the finding, shown before anything is saved. */
  const offerFoundWallet = async (found: {
    readonly account: `0x${string}`;
    readonly validator: `0x${string}`;
    readonly publicKey: { readonly x: Hex; readonly y: Hex };
    readonly credentialId: Hex;
    readonly chainId: number;
    readonly accountHandle: Hex;
    readonly passkeyBackup: NonNullable<AccountHandle["passkeyBackup"]>;
    readonly client: { getCode: (input: { address: `0x${string}` }) => Promise<string | undefined> };
  }) => {
    const existing = accounts.find(candidate => candidate.account.toLowerCase() === found.account.toLowerCase());
    const code = await found.client.getCode({ address: found.account }).catch(() => undefined);
    setFoundByPasskey({
      account: found.account,
      validator: found.validator,
      publicKey: found.publicKey,
      credentialId: found.credentialId,
      chainId: found.chainId,
      accountHandle: found.accountHandle,
      passkeyBackup: found.passkeyBackup,
      deployed: Boolean(code && code !== "0x"),
      alreadySaved: existing?.label ?? null
    });
  };

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
      await services.runtime.verify(config, deployment);
      const client = services.publicClients.forEndpoint(config.rpcUrl);

      const discovered = await discoverPasskeyAccount({
        chainId: deployment.chainId,
        factory: deployment.factory,
        rpId: window.location.hostname,
        origin: window.location.origin,
        challenge: assertion.challenge,
        assertion: {
          credentialId: assertion.credentialId,
          userHandle: assertion.userHandle,
          authenticatorData: hexFromBytes(assertion.authenticatorData),
          clientDataJSON: hexFromBytes(assertion.clientDataJSON),
          signature: hexFromBytes(assertion.signature)
        },
        stateTransport: createRpcStateTransport({ endpoint: config.rpcUrl }),
        verificationStateTransport: createRpcStateTransport({ endpoint: config.verificationRpcUrl })
      });
      if (discovered.status === "invalid") {
        setMessage(discovered.reason === "deployment"
          ? "That passkey belongs to a different chain or Loom deployment. Select its canonical deployment and try again."
          : "That passkey assertion could not be verified for this wallet.");
        return;
      }
      if (discovered.status === "not-activated") {
        setMessage("That account handle is not registered in this deployment. A new wallet must be activated on chain before it can be restored on another device.");
        return;
      }
      if (discovered.status === "stale") {
        setMessage("That passkey locates this wallet, but its key is not installed anymore. It may have been replaced by a later recovery.");
        return;
      }
      await offerFoundWallet({
        account: discovered.account,
        validator: discovered.validator,
        publicKey: { x: discovered.publicKey.x, y: discovered.publicKey.y },
        credentialId: assertion.credentialId,
        chainId: deployment.chainId,
        accountHandle: assertion.accountHandle,
        passkeyBackup: backupObservation(credentialBackupState(assertion.authenticatorData), "assertion"),
        client
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
        version: 3,
        kind: "recovered",
        id: `passkey:${foundByPasskey.account.toLowerCase()}`,
        label: "Recovered wallet",
        account: foundByPasskey.account,
        chainId: foundByPasskey.chainId,
        credentialId: foundByPasskey.credentialId,
        publicKey: foundByPasskey.publicKey,
        rpId: window.location.hostname,
        origin: window.location.origin,
        accountHandle: foundByPasskey.accountHandle,
        passkeyBackup: foundByPasskey.passkeyBackup,
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
      () => { void refreshAccounts(); },
      async updated => {
        await services.accounts.save(updated);
        setSelected(updated);
        await refreshAccounts();
      }
    )}</RouteChunk></main>
    <button className="desktop-theme theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? "◐" : "☀"}</button>
    <nav className="bottom-nav" aria-label="Mobile navigation">{primaryNavigation.map(item => <NavButton key={item.id} item={item} current={area} onClick={setArea} />)}</nav>
  </div>;
}

function NavButton({ item, current, onClick }: { item: { id: NavigationArea; label: string; icon: string }; current: NavigationArea; onClick(area: NavigationArea): void }) {
  return <button className={current === item.id ? "nav-item active" : "nav-item"} aria-current={current === item.id ? "page" : undefined} onClick={() => onClick(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>;
}

function renderArea(area: NavigationArea, navigate: (area: NavigationArea) => void, account: AccountHandle, switchAccount: () => void, lockAccount: () => void, openRecovery: () => void, guardianInboundLink: string, stopRecovery: () => void, onRenamed: () => void, onAccountUpdate: (account: AccountHandle) => Promise<void>) {
  switch (area) {
    case "home": return <HomePage account={account} onNavigate={navigate} onSwitch={switchAccount} onLock={lockAccount} onStopRecovery={stopRecovery} />;
    case "activity": return <ActivityPage account={account} />;
    case "apps": return <AppsPage account={account} />;
    case "security": return <SecurityPage account={account} onGuardian={() => navigate("guardian")} onRecovery={openRecovery} onAccountUpdate={onAccountUpdate} />;
    case "guardian": return <GuardianWorkspace account={account} inboundLink={guardianInboundLink} />;
    case "developer": return <DeveloperSettings account={account} onRenamed={onRenamed} />;
  }
}

/** Where the warning on the wallet sends an owner who wants this stopped. */
export const STOP_RECOVERY_PATH = "/recover/stop";
