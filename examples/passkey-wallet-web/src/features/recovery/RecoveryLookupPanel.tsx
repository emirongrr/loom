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
import { recoveryGasPayers, selectRecoveryGasPayer } from "./recoveryGasPayer";
import { GasPayerChoice } from "./GasPayerChoice";
import { submitAccountCalls } from "../wallet/accountClient";
import type { AccountHandle } from "../../types";

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
export function RecoveryLookupPanel({ fixedAccount, accounts = [] }: {
  readonly fixedAccount?: Address;
  /** Saved wallets that could pay for the execution, so paying does not
      require a browser extension. */
  readonly accounts?: readonly AccountHandle[];
} = {}) {
  const { config } = useNetwork();
  const { publicClients, runtime, pendingOperations } = useAppServices();
  const [deployment, setDeployment] = useState<WalletDeployment | null>(null);
  const [deploymentError, setDeploymentError] = useState("");
  const [address, setAddress] = useState<string>(fixedAccount ?? "");
  const [result, setResult] = useState<RecoveryLookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Set once this panel finished a recovery, so the screen can say so
      after the record it was reading is gone from the chain. */
  const [executed, setExecuted] = useState<Hex | "">("");
  // Publishing a recovery passkey and proposing a recovery are separate steps,
  // and only the second one writes the record this panel reads. An account
  // stranded between them looks identical to an account that never started,
  // which reads as the chain having lost the publication it was paid for.
  const [published, setPublished] = useState<PublicationScan | null>(null);
  /** Which wallet pays. Asked once, when there is more than one way to pay. */
  const [choosing, setChoosing] = useState(false);
  const [payerId, setPayerId] = useState("");

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
    setError(""); setResult(null); setExecuted(""); setPublished(null);
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

  const loomCandidates = result ? recoveryGasPayers(accounts, deployment?.chainId ?? 0, result.account) : [];
  const loomPayer = selectRecoveryGasPayer(loomCandidates, payerId);
  const browserWallet = Boolean((window as { ethereum?: Eip1193Provider }).ethereum);

  const execute = async (via: "loom" | "browser") => {
    setError("");
    if (!manager || !result || !record) return;
    const provider = (window as { ethereum?: Eip1193Provider }).ethereum;
    if (via === "browser" && !provider) { setError("No browser wallet is available to pay for this transaction."); return; }
    if (via === "loom" && !loomPayer) return;
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
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as never });
      // Identical calldata either way. Who pays changes nothing the manager
      // checks: it verifies the recovery, never the sender.
      const hash = via === "loom"
        ? await submitAccountCalls({
          config, account: loomPayer!, deployment: deployment!,
          calls: [{ target: manager, value: 0n, data }],
          pendingOperations, runtime, publicClients
        }).then(submitted => submitted.transactionHash ?? submitted.userOpHash)
        : await sendEip1193Transaction({
          provider: provider!, chainId: deployment!.chainId, to: manager, data
        });
      setExecuted(hash);
      setChoosing(false);
      setResult(await lookupRecovery({
        publicClient: publicClients.forEndpoint(config.rpcUrl), recoveryManager: manager, account: result.account
      }));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "The transaction was not sent.");
    } finally { setBusy(false); }
  };

  // Driven by the account already being recovered when one is given, so the
  // reader never types the same address twice. Execution needs no session and
  // no passkey on this device -- an approved recovery whose delay has elapsed
  // can be finished by anyone willing to pay the gas (ADR-0025) -- which is
  // why this stays reachable even though nothing else here requires it.
  useEffect(() => {
    if (fixedAccount && manager && !result && !busy) void look();
  }, [fixedAccount, manager]);

  const body = <>
    <p className="form-note">
      Anyone can read whether an account has a recovery pending. A pending request is itself proof that the
      guardians approved it, because the manager verifies the threshold before it records one. Finishing one
      grants the publisher no authority: it only pays the gas.
    </p>

    {fixedAccount
      ? <button className="secondary" disabled={busy || !deployment} onClick={() => void look()}>
        {busy ? "Reading…" : "Re-read chain state"}
      </button>
      : <>
        <label className="field"><span>Account address</span>
          <input value={address} disabled={busy} spellCheck={false} autoComplete="off" placeholder="0x…"
            onChange={event => setAddress(event.target.value)} />
        </label>
        <button className="secondary" disabled={busy || !deployment} onClick={() => void look()}>
          {busy ? "Reading…" : "Look up"}
        </button>
      </>}

    {deploymentError && <p className="callout warning">{deploymentError}</p>}
    {error && <p className="callout warning">{error}</p>}

    {result && result.lookup.kind === "none" && !executed && <div className="callout">
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

    {executed && <div className="callout success">
      <strong>Recovery complete.</strong>
      <p>
        The account's validators have been replaced. Its address is unchanged, and the recovery passkey now
        controls it. Nothing here is left to do.
      </p>
      <p className="breakable">Transaction {executed}</p>
    </div>}

    {result && found && record && !executed && <>
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

      {!choosing
        ? <button className="primary" disabled={busy || blockers.length > 0} onClick={() => { setError(""); setChoosing(true); }}>
          {busy ? "Working…" : "Execute recovery"}
        </button>
        : <div className="callout">
          <strong>Who pays the gas?</strong>
          {/* Paying grants nothing. The manager verifies the recovery, never
              the sender, so this is a question about a fee and not about
              authority -- said once, here, rather than beside every button. */}
          <p className="form-note">Whoever pays gains no authority over the account being recovered.</p>

          {loomCandidates.length > 0 && <>
            <GasPayerChoice
              label="A saved Loom wallet"
              candidates={loomCandidates}
              selected={loomPayer}
              disabled={busy}
              onSelect={setPayerId}
            />
            <button className="primary" disabled={busy || !loomPayer} onClick={() => void execute("loom")}>
              {busy ? "Confirm on your device…" : "Pay with this Loom wallet"}
            </button>
          </>}

          {browserWallet
            ? <button className="secondary" disabled={busy} onClick={() => void execute("browser")}>Pay with a browser wallet</button>
            : <p className="form-note">No browser wallet is available on this device.</p>}

          {loomCandidates.length === 0 && !browserWallet
            && <p className="callout warning">Nothing here can pay for it. Save a funded Loom wallet on this chain, or open this page where a browser wallet is available.</p>}

          <button className="text-button" disabled={busy} onClick={() => setChoosing(false)}>Cancel</button>
        </div>}
    </>}
  </>;

  return <section className="section-card" aria-labelledby="recovery-lookup-title">
    <div className="section-heading"><div>
      <p className="eyebrow">Read from the chain</p>
      <h2 id="recovery-lookup-title">{fixedAccount ? "Finish this recovery" : "Look up a recovery by address"}</h2>
    </div></div>
    {body}
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
