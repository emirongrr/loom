import { useEffect, useState } from "react";
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { executionBlockers, selectLocalInitData, verifyExecutionArguments } from "./recoveryLookup";
import { createRecoverySessionRepository } from "./recoverySession";
import { createRecoveryDraftRepository } from "./recoveryDraft";
import { encodeExecuteRecovery, lookupRecovery, type RecoveryLookupResult } from "./recoveryLookupClient";
import type { PendingRecoveryRecord } from "./recoveryLookup";
import { sendEip1193Transaction, type Eip1193Provider } from "./recoveryPasskey";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";

/**
 * Look up a recovery for any account, from nothing but its address.
 *
 * The rest of this page works from a session held on the device that started
 * the recovery. Someone who lost that device still needs to see whether their
 * recovery is alive and, if the initialization data can be produced, finish it.
 * The manager's state is public, so this asks the chain directly.
 *
 * It never invents the one thing the chain does not hold. Only the hash of the
 * new validator's initialization data is on chain, so the data itself has to be
 * supplied, and it is checked against that hash before anything is offered.
 */
export function RecoveryLookupPanel() {
  const { config } = useNetwork();
  const { publicClients, runtime } = useAppServices();
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [deploymentError, setDeploymentError] = useState("");
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<RecoveryLookupResult | null>(null);
  const [initData, setInitData] = useState<Hex | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<Hex | "">("");

  // Load the profile and check the deployed bytecode against it before offering
  // anything. Reading a recovery from a manager this build does not recognise
  // would be reporting on a contract whose rules are unknown here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profile = await loadWalletDeployment();
        await runtime.verify(config, profile);
        if (!cancelled) setDeployment(profile);
      } catch (issue) {
        if (!cancelled) setDeploymentError(issue instanceof Error ? issue.message : "The deployment could not be verified.");
      }
    })();
    return () => { cancelled = true; };
  }, [config, runtime]);

  const manager = deployment?.recoveryModule as Address | undefined;
  const found = result && result.lookup.kind !== "none" ? result.lookup : null;
  const record = found?.record ?? null;

  const argumentCheck = record && initData
    ? verifyExecutionArguments({ record, oldValidators: result!.oldValidators, initData })
    : null;

  const blockers = result
    ? executionBlockers({ lookup: result.lookup, hasInitData: Boolean(argumentCheck?.ok) })
    : [];
  const otherBlockers = blockers.filter(reason => !reason.includes("initialization data"));

  // Everything this device could legitimately hold for a pending recovery: the
  // sessions it started and the drafts it prepared. Matched by hash, so a stale
  // record for the same account cannot stand in for the approved one.
  const localInitData = async (record: PendingRecoveryRecord) => {
    const candidates: Hex[] = [];
    try {
      const sessions = await createRecoverySessionRepository().inspect();
      for (const session of sessions.sessions) if (session.local?.initData) candidates.push(session.local.initData);
    } catch { /* an unreadable store is not a reason to claim the data is absent */ }
    try {
      const drafts = await createRecoveryDraftRepository().inspect();
      for (const draft of drafts.drafts) if (draft.preparation?.initData) candidates.push(draft.preparation.initData);
    } catch { /* same */ }
    return selectLocalInitData({ record, candidates });
  };

  const look = async () => {
    setError(""); setResult(null); setSent("");
    if (!manager) { setError("The deployment profile has not loaded, so there is no recovery manager to ask."); return; }
    if (!isAddress(address.trim())) { setError("Enter a valid account address."); return; }
    setBusy(true);
    try {
      const found = await lookupRecovery({
        publicClient: publicClients.forEndpoint(config.rpcUrl),
        recoveryManager: manager,
        account: getAddress(address.trim())
      });
      setResult(found);
      setInitData(found.lookup.kind === "none" ? "" : (await localInitData(found.lookup.record)) ?? "");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "The lookup failed.");
    } finally { setBusy(false); }
  };

  const execute = async () => {
    setError(""); setSent("");
    const provider = (window as { ethereum?: Eip1193Provider }).ethereum;
    if (!provider) { setError("No browser wallet is available to pay for this transaction."); return; }
    if (!manager || !result || !record) return;
    setBusy(true);
    try {
      // Re-read immediately before submitting. The delay may have expired, or
      // the configuration moved, in the time the page was open.
      const fresh = await lookupRecovery({
        publicClient: publicClients.forEndpoint(config.rpcUrl), recoveryManager: manager, account: result.account
      });
      if (fresh.lookup.kind !== "ready") {
        setResult(fresh);
        setError("The recovery is no longer executable. The refreshed state is shown above.");
        return;
      }
      const recheck = verifyExecutionArguments({
        record: fresh.lookup.record, oldValidators: fresh.oldValidators, initData: initData as Hex
      });
      if (!recheck.ok) { setResult(fresh); setError(recheck.problems.join(" ")); return; }

      const call = encodeExecuteRecovery({
        account: fresh.account, oldValidators: fresh.oldValidators, initData: initData as Hex
      });
      const hash = await sendEip1193Transaction({
        provider,
        chainId: deployment!.chainId,
        to: manager,
        data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as never })
      });
      setSent(hash);
      setResult(await lookupRecovery({
        publicClient: publicClients.forEndpoint(config.rpcUrl), recoveryManager: manager, account: result.account
      }));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "The transaction was not sent.");
    } finally { setBusy(false); }
  };

  return <section className="section-card" aria-labelledby="recovery-lookup-title">
    <div className="section-heading"><div>
      <p className="eyebrow">Read from the chain</p>
      <h2 id="recovery-lookup-title">Look up a recovery by address</h2>
    </div></div>
    <p className="form-note">
      Anyone can read whether an account has a recovery pending. A pending request is itself proof that the
      guardians approved it, because the manager verifies the threshold before it records one.
    </p>

    <label className="field"><span>Account address</span>
      <input value={address} disabled={busy} spellCheck={false} autoComplete="off" placeholder="0x…"
        onChange={event => setAddress(event.target.value)} />
    </label>
    <button className="secondary" disabled={busy || !deployment} onClick={() => void look()}>
      {busy ? "Reading…" : "Look up"}
    </button>

    {deploymentError && <p className="callout warning">{deploymentError}</p>}
    {error && <p className="callout warning">{error}</p>}

    {result && result.lookup.kind === "none" && <p className="callout">
      No recovery is pending for this account at block {String(result.blockNumber)}.
    </p>}

    {result && found && record && <>
      <div className="callout">
        <strong>{statusLabel(found.kind)}</strong>
        <p className="breakable">
          New validator {record.newValidator} · new guardian root {record.newGuardianRoot} · threshold{" "}
          {record.newGuardianThreshold} · nonce {String(record.nonce)}
        </p>
        <p>
          {timing(found.kind === "delay-active" ? found.secondsUntilReady : found.secondsUntilExpiry,
            found.kind === "delay-active")}
          {" · approved against config version "}{String(record.configVersion)}
          {result.liveConfigVersion !== record.configVersion && ` (account is now at ${String(result.liveConfigVersion)})`}
        </p>
      </div>

      {argumentCheck?.ok
        ? <p className="callout success">
          The execution data for this recovery was found on this device and matches what the guardians approved.
        </p>
        : <p className="callout">
          <strong>This recovery can only be completed on the device that started it.</strong>
          <span> The new validator's initialization data is not published -- only its hash is -- and it is not stored
            here. It also would not be enough on its own: it carries the new passkey's public key, and that passkey
            exists only on the device that created it, so the account would still be unusable. Start a new recovery
            instead.</span>
        </p>}

      {/* The missing-data case has its own explanation above; repeating it here
          would say the same thing twice and bury the reasons that differ. */}
      {otherBlockers.length > 0 && <ul className="form-note">{otherBlockers.map(reason => <li key={reason}>{reason}</li>)}</ul>}

      <button className="primary" disabled={busy || blockers.length > 0} onClick={() => void execute()}>
        {busy ? "Working…" : "Execute recovery"}
      </button>
      <p className="form-note">
        Execution is permissionless: any wallet may pay for it and none of them gain authority over the account.
      </p>
      {sent && <p className="callout success breakable">Submitted: {sent}</p>}
    </>}
  </section>;
}

function statusLabel(kind: string): string {
  if (kind === "ready") return "Approved and executable now";
  if (kind === "delay-active") return "Approved, waiting for the on-chain delay";
  if (kind === "expired") return "Expired before it was executed";
  if (kind === "stale-config") return "Approved, but the account configuration has since changed";
  return "No recovery pending";
}

function timing(seconds: number, untilReady: boolean): string {
  const magnitude = Math.abs(seconds);
  const value = magnitude >= 86400
    ? `${(magnitude / 86400).toFixed(1)} days`
    : magnitude >= 3600 ? `${(magnitude / 3600).toFixed(1)} hours` : `${Math.round(magnitude / 60)} minutes`;
  if (untilReady) return `Executable in ${value}`;
  return seconds >= 0 ? `${value} left to execute` : `Window closed ${value} ago`;
}
