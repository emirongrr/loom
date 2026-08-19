import { useEffect, useState } from "react";
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { executionBlockers, verifyExecutionArguments } from "./recoveryLookup";
import { encodeExecuteRecovery, lookupRecovery, type RecoveryLookupResult } from "./recoveryLookupClient";
import { sendEip1193Transaction, type Eip1193Provider } from "./recoveryPasskey";
import { loadWalletDeployment, type WalletDeployment } from "../onboarding/accountLifecycle";
import { readPublishedRecoveryValidators, type PublicationScan } from "./existingPublications";
import { RecoveryManagerAbi } from "@loom/core/abi";

/**
 * Look up a recovery for any account, and finish it, from nothing but its
 * address.
 *
 * The rest of this page works from a session held on the device that started
 * the recovery. That device is no longer required to finish one: the validator
 * is initialized when it is deployed (ADR-0025), so execution carries no
 * initializer and nothing has to survive anywhere. Anyone with gas can complete
 * an approved, matured recovery.
 *
 * What this cannot do is decide that a recovery is legitimate. It reports what
 * the chain says and refuses to offer a call the manager would reject.
 */
export function RecoveryLookupPanel() {
  const { config } = useNetwork();
  const { publicClients, runtime } = useAppServices();
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [deploymentError, setDeploymentError] = useState("");
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<RecoveryLookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<Hex | "">("");
  // Publishing a recovery passkey and proposing a recovery are separate steps,
  // and only the second one writes the record this panel reads. An account
  // stranded between them looks identical to an account that never started,
  // which reads as the chain having lost the publication it was paid for.
  const [published, setPublished] = useState<PublicationScan | null>(null);

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

  const argumentCheck = record ? verifyExecutionArguments({ record, oldValidators: result!.oldValidators }) : null;

  const blockers = result ? executionBlockers({ lookup: result.lookup }) : [];

  const look = async () => {
    setError(""); setResult(null); setSent(""); setPublished(null);
    if (!manager) { setError("The deployment profile has not loaded, so there is no recovery manager to ask."); return; }
    if (!isAddress(address.trim())) { setError("Enter a valid account address."); return; }
    setBusy(true);
    try {
      const publicClient = publicClients.forEndpoint(config.rpcUrl);
      const account = getAddress(address.trim());
      const found = await lookupRecovery({ publicClient, recoveryManager: manager, account });
      setResult(found);

      // Nothing pending is not the same as nothing happened. Ask the
      // provisioner's log whether a recovery passkey was published for this
      // account, so the answer separates "never started" from "started and
      // never proposed".
      const provisioner = deployment?.recoveryValidatorProvisioner;
      if (found.lookup.kind === "none" && provisioner) {
        const recoveryNonce = await publicClient.readContract({
          address: manager, abi: RecoveryManagerAbi, functionName: "recoveryNonces", args: [account]
        }) as bigint;
        setPublished(await readPublishedRecoveryValidators({
          publicClient,
          verificationClient: publicClients.forEndpoint(config.verificationRpcUrl),
          factory: provisioner.address, account, recoveryNonce
        }));
      }
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
      const recheck = verifyExecutionArguments({ record: fresh.lookup.record, oldValidators: fresh.oldValidators });
      if (!recheck.ok) { setResult(fresh); setError(recheck.problems.join(" ")); return; }

      const call = encodeExecuteRecovery({ account: fresh.account, oldValidators: fresh.oldValidators });
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

    {result && result.lookup.kind === "none" && <div className="callout">
      <p>No recovery is pending for this account at block {String(result.blockNumber)}.</p>
      {published && published.published.length > 0 && <>
        <p>
          A recovery passkey <strong>was</strong> published for this account. Publishing the validator and
          proposing the recovery are separate steps, and only the proposal creates the record this lookup
          reads. The recovery is waiting on guardian approvals, from the device holding that passkey.
        </p>
        <ul>
          {published.published.map(entry => <li key={entry.validator} className="breakable">
            {entry.validator} · block {String(entry.blockNumber)}
          </li>)}
        </ul>
      </>}
      {published && !published.consistent && <p>
        The two endpoints disagreed about this account's publication history, so the list above is the union of
        both reads and may still be short. Confirm on an explorer before publishing another recovery passkey.
      </p>}
      {published && published.published.length === 0 && !published.complete && <p>
        Whether a recovery passkey was ever published could not be settled: the log scan reached back only to
        block {String(published.scannedFromBlock)} before the endpoint stopped serving it.
      </p>}
    </div>}

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

      {argumentCheck && !argumentCheck.ok && <p className="callout warning">{argumentCheck.problems.join(" ")}</p>}

      {blockers.length > 0 && <ul className="form-note">{blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>}

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
