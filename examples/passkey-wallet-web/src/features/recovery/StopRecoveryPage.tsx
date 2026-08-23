import { useEffect, useMemo, useState } from "react";
import { encodeFunctionData } from "viem";
import { RecoveryManagerAbi } from "@loom/core/abi";
import {
  cancelApprovalFromResponse, createCancelRequest, createRecoveryId, parseCancelResponse,
  serializeRecoveryProtocol, type CancelRequestV1
} from "@loom/sdk/recovery";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { createQrGeometry } from "../../components/qrCode";
import { Callout } from "../../components/Callout";
import { useClipboard } from "../../components/useClipboard";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import { loadWalletDeployment } from "../onboarding/accountLifecycle";
import { createAccountGuardianClient } from "../security/guardianClient";
import { GuardianInviteLinks } from "./GuardianInviteLinks";
import { cancellationHorizon } from "../guardians/pendingCancellations";
import { mergeApprovals, readBoardCancellations } from "./boardApprovals";
import { submitAccountCalls } from "../wallet/accountClient";
import { humanDuration, planStopRecovery, preferredRoute, shortAddress, type StopRecoveryPlan } from "./stopRecovery";
import type { Address, Hex } from "@loom/core";
import type { AccountHandle } from "../../types";

/**
 * The page an account owner reaches from the warning on their wallet.
 *
 * The warning could say a recovery was underway and then led nowhere. This is
 * the "and then what": when it happens, who has to agree to stop it, and the
 * request those people need in order to say so.
 *
 * It does not pretend the owner can act alone. Cancelling takes the account
 * plus one fewer than the guardian threshold, or the full threshold without
 * the account (ADR-0023) -- and that is not a limitation to route around, it
 * is the reason a stolen key cannot block a recovery the guardians approved.
 */
export function StopRecoveryPage({ handle, onClose }: {
  readonly handle: AccountHandle;
  readonly onClose: () => void;
}) {
  const account = handle.account;
  const chainId = handle.chainId;
  const { config } = useNetwork();
  const services = useAppServices();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "none" }
    | { readonly kind: "unreadable"; readonly reason: string }
    | {
      readonly kind: "pending";
      readonly plan: StopRecoveryPlan;
      readonly request: CancelRequestV1;
      readonly recoveryManager: Address;
    }
  >({ kind: "loading" });
  const [pasted, setPasted] = useState("");
  const [collected, setCollected] = useState<readonly {
    readonly leaf: Hex;
    readonly approval: ReturnType<typeof cancelApprovalFromResponse>;
  }[]>([]);
  const [message, setMessage] = useState("");
  const clipboard = useClipboard();
  const [qr, setQr] = useState("");
  const [fromBoard, setFromBoard] = useState<readonly { readonly guardianLeaf: Hex; readonly approval: ReturnType<typeof cancelApprovalFromResponse>; readonly confirmed: boolean }[]>([]);
  const [boardMessage, setBoardMessage] = useState("");
  // A guardian's bearer link lands on this page. Filling the box rather than
  // consuming it silently keeps the reader in the loop: they still press the
  // button, and still see it checked.
  const [pastedFromLink] = useState(() => location.hash.includes("cap=") ? location.href : "");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const deployment = await loadWalletDeployment();
        if (deployment.chainId !== chainId || !deployment.recoveryModule) {
          if (!cancelled) setState({ kind: "unreadable", reason: "This deployment has no recovery manager on the account's chain." });
          return;
        }
        const client = createAccountGuardianClient({
          config, chainId: deployment.chainId, account,
          recoveryManager: deployment.recoveryModule, publicClients: services.publicClients
        });
        const pending = await client.readPendingRecovery();
        if (cancelled) return;
        if (!pending.pending) { setState({ kind: "none" }); return; }

        const live = await client.inspectAccount();
        const recoveryId = createRecoveryId({
          account,
          oldValidatorsHash: pending.oldValidatorsHash,
          newValidator: pending.newValidator,
          initDataHash: pending.initDataHash,
          newGuardianRoot: pending.newGuardianRoot,
          newGuardianThreshold: pending.newGuardianThreshold,
          configVersion: pending.configVersion,
          nonce: pending.nonce
        });
        const now = pending.chainTimestamp ?? BigInt(Math.floor(Date.now() / 1000));
        const createdAt = Number(now);
        if (cancelled) return;
        setState({
          kind: "pending",
          recoveryManager: deployment.recoveryModule,
          plan: planStopRecovery({
            newValidator: pending.newValidator,
            readyAt: pending.readyAt,
            expiresAt: pending.expiresAt,
            guardianThreshold: live.guardianThreshold,
            nowSeconds: now,
            accountAvailable: true,
            collectedGuardians: 0
          }),
          request: createCancelRequest({
            recoveryId,
            chainId: deployment.chainId,
            account,
            recoveryManager: deployment.recoveryModule,
            guardianRoot: live.guardianRoot,
            guardianThreshold: live.guardianThreshold,
            configVersion: pending.configVersion.toString(),
            nonce: pending.nonce.toString(),
            createdAt,
      // Bounded by the recovery's own window while it can still execute, so a
      // signature never outlives what it authorises. Once that window has
      // closed the recovery does not go away -- it keeps the slot, and no new
      // recovery can be proposed until it is cancelled -- so cancelling it
      // stays meaningful and the request gets an ordinary lifetime.
            expiresAt: cancellationHorizon(createdAt, Number(pending.expiresAt))
          })
        });
      } catch (error) {
        if (!cancelled) setState({ kind: "unreadable", reason: error instanceof Error ? error.message : "The chain could not be read." });
      }
    })();
    return () => { cancelled = true; };
  }, [account, chainId, config, services.publicClients]);

  const signatures = useMemo(() => mergeApprovals({
    collected: collected.map(entry => ({ leaf: entry.leaf, approval: entry.approval as never })),
    published: fromBoard as never
  }), [collected, fromBoard]);

  const cancelCalls = useMemo(() => {
    if (state.kind !== "pending" || signatures.length === 0) return null;
    const tuples = [...signatures]
      .map(approval => ({ ...approval, leaf: (approval as { leaf?: Hex }).leaf ?? `0x${""}` as Hex }))
      .sort((left, right) => left.leaf.toLowerCase() < right.leaf.toLowerCase() ? -1 : 1)
      .map(approval => ({
        verifier: approval.verifier, keyCommitment: approval.keyCommitment,
        salt: approval.salt, signature: approval.signature, proof: approval.proof
      }));
    return {
      to: state.recoveryManager,
      guardiansOnly: encodeFunctionData({ abi: RecoveryManagerAbi, functionName: "cancelRecoveryWithGuardians", args: [account, tuples] }),
      // The manager checks the sender on this one, so it only counts when the
      // account itself makes the call -- which is the whole point of the route.
      withAccount: encodeFunctionData({ abi: RecoveryManagerAbi, functionName: "cancelRecoveryWithAccountAndGuardians", args: [account, tuples] })
    };
  }, [account, signatures, state]);

  if (state.kind === "loading") {
    return <main className="wallet-landing recovery-layout"><section className="landing-panel">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p>Reading the account&apos;s recovery state…</p>
    </section></main>;
  }
  if (state.kind === "none") {
    return <main className="wallet-landing recovery-layout"><section className="landing-panel">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p className="eyebrow">Account recovery</p>
      <h1>Nothing to stop</h1>
      <p>This account has no pending recovery. If one is proposed, the warning on your wallet will bring you back here.</p>
      <div className="guardian-actions"><button className="secondary" onClick={onClose}>Back to the wallet</button></div>
    </section></main>;
  }
  if (state.kind === "unreadable") {
    return <main className="wallet-landing recovery-layout"><section className="landing-panel">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p className="eyebrow">Account recovery</p>
      <h1>The recovery state could not be read</h1>
      <div className="callout warning"><strong>Unreadable, which is not the same as nothing pending.</strong><p>{state.reason}</p></div>
      <p className="form-note">Try again before concluding anything.</p>
      <div className="guardian-actions"><button className="secondary" onClick={onClose}>Back to the wallet</button></div>
    </section></main>;
  }

  // Recomputed against the collected count so the routes answer the question
  // the reader is actually asking: how many more signatures do I need.
  // One guardian fills one seat however their signature arrived.
  const seatsFilled = new Set([
    ...collected.map(entry => entry.leaf.toLowerCase()),
    ...fromBoard.map(entry => entry.guardianLeaf.toLowerCase())
  ]).size;
  const shown = planStopRecovery({
    newValidator: state.plan.newValidator,
    readyAt: state.plan.milestones[1]!.at,
    expiresAt: state.plan.milestones[2]!.at,
    guardianThreshold: state.plan.guardianThreshold,
    nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    accountAvailable: true,
    collectedGuardians: seatsFilled
  });
  const first = preferredRoute(shown);
  // The account route asks fewer people, so it wins when it is open and met.
  const ready: "account-and-guardians" | "guardians-only" | null =
    shown.routes[0]!.satisfied ? "account-and-guardians" : shown.routes[1]!.satisfied ? "guardians-only" : null;

  const addResponse = async () => {
    setMessage("");
    try {
      const artifact = (pasted || pastedFromLink).trim();
      // Guardians return either the signature itself or the bearer link that
      // carries it. Accepting only one of the two would send half of them back
      // to ask which.
      const payload = artifact.startsWith("{")
        ? artifact
        : await createEncryptedLinkTransport<Record<string, unknown>>({ origin: window.location.origin, path: "/recover/stop" }).receive(artifact);
      const response = parseCancelResponse(payload, state.request);
      const approval = cancelApprovalFromResponse(response);
      if (collected.some(entry => entry.leaf.toLowerCase() === approval.leaf.toLowerCase())) {
        setMessage("That guardian has already signed. A second signature from the same guardian fills no new seat.");
        return;
      }
      setCollected([...collected, { leaf: approval.leaf, approval }]);
      setPasted("");
      setMessage("Signature accepted. It is checked against live guardian state again before anything is sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That is not a cancellation signature for this recovery.");
    }
  };

  /**
   * Collect cancellation signatures guardians published on chain.
   *
   * The same two routes a recovery has: a guardian can hand their signature
   * over privately, or publish it so it can be picked up without reaching this
   * device. A cancellation races a delay that is already running, so the route
   * that does not need everyone reachable is the one that decides whether the
   * quorum can act at all.
   *
   * Nothing read here is trusted. Each signature is rebuilt and re-verified by
   * the manager when the cancellation is submitted.
   */
  const collectFromChain = async () => {
    setBoardMessage("");
    try {
      const deployment = await loadWalletDeployment();
      if (!deployment.recoveryIntentBoard) {
        setBoardMessage("This deployment publishes no recovery intent board, so there is nothing to collect.");
        return;
      }
      const scan = await readBoardCancellations({
        chainId, account, board: deployment.recoveryIntentBoard,
        recoveryManager: state.recoveryManager, recoveryId: state.request.recoveryId,
        logTransport: undefined
      });
      setFromBoard(scan.approvals as never);
      setBoardMessage(scan.unavailable
        ?? (scan.approvals.length === 0
          ? "No cancellation has been published on chain for this recovery."
          : `${scan.approvals.length} published cancellation signature(s) found.`));
    } catch (error) {
      setBoardMessage(error instanceof Error ? error.message : "The board could not be read.");
    }
  };

  const shareRequest = async (asQr: boolean) => {
    const text = serializeRecoveryProtocol(state.request);
    if (asQr) { setQr(qr ? "" : text); return; }
    await clipboard.copy(text, { what: "Cancellation request", fallback: "Show the QR instead." });
  };

  const copyCall = async () => {
    if (!cancelCalls) return;
    await clipboard.copy(
      JSON.stringify({ to: cancelCalls.to, data: cancelCalls.guardiansOnly }, null, 2),
      { what: "Exact transaction", fallback: "Send it from this wallet instead." }
    );
  };

  /**
   * Cancel with this wallet plus the guardians who signed.
   *
   * Sent as an operation from the account, because `cancelRecoveryWithAccountAndGuardians`
   * requires `msg.sender == account`. The guardian signatures still carry the
   * authority; the account only proves it is present. It is revalidated against
   * live guardian state by the manager itself, which will refuse a stale root,
   * a stale configuration version, or a nonce that has moved on.
   */
  const cancelWithThisWallet = async (route: "account-and-guardians" | "guardians-only") => {
    if (!cancelCalls) { setMessage("There are no signatures to send yet."); return; }
    setBusy(true); setMessage(""); setSent("");
    try {
      const deployment = await loadWalletDeployment();
      const result = await submitAccountCalls({
        config, account: handle, deployment,
        calls: [{
          target: cancelCalls.to,
          value: 0n,
          data: route === "account-and-guardians" ? cancelCalls.withAccount : cancelCalls.guardiansOnly
        }],
        pendingOperations: services.pendingOperations, runtime: services.runtime, publicClients: services.publicClients
      });
      setSent(result.transactionHash ?? result.userOpHash);
      setMessage("Cancellation submitted. Reopen this page to confirm the chain no longer holds a pending recovery.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The cancellation could not be submitted.");
    } finally {
      setBusy(false);
    }
  };

  const geometry = qr ? createQrGeometry(qr) : null;

  return <main className="wallet-landing recovery-layout">
    <section className="landing-panel" aria-labelledby="stop-recovery-title">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p className="eyebrow">Account recovery · {state.request.humanCode}</p>
      <h1 id="stop-recovery-title">{shown.headline}</h1>
      <div className={shown.phase === "delay" ? "callout warning" : shown.phase === "executable" ? "callout warning" : "callout"}>
        <strong>{shown.remaining}</strong>
        <p>{shown.urgency}</p>
      </div>
      <p className="breakable">
        Control would move to {shortAddress(shown.newValidator)}. If you started this recovery, there is nothing to do here.
      </p>

      <div className="permission-grid">
        {shown.milestones.map(milestone => <div key={milestone.id}>
          <span>{milestone.label}</span>
          <strong>{new Date(Number(milestone.at) * 1000).toLocaleString()}{milestone.reached ? " ✓" : ""}</strong>
        </div>)}
      </div>

      <div className="section-heading"><div><p className="eyebrow">Nobody can do this alone</p><h2>Who has to agree</h2></div></div>
      {shown.routes.map(route => <div key={route.id} className={route.satisfied ? "callout success" : route.id === first.id ? "callout warning" : "callout"}>
        <strong>{route.title}</strong>
        <p>{route.detail}</p>
        <p className="form-note">
          {route.collected} of {route.guardiansNeeded} guardian signature{route.guardiansNeeded === 1 ? "" : "s"} collected
          {route.satisfied ? " — enough for this route." : "."}
        </p>
      </div>)}

      <div className="section-heading"><div><p className="eyebrow">One request, every guardian</p><h2>Ask your guardians</h2></div></div>
      <p>
        Someone who is not a guardian of this account cannot produce a signature it accepts, so the same message can go
        to all of them. Compare the six-digit code with each guardian over an independent channel.
      </p>
      <div className="guardian-actions">
        <button className="secondary" onClick={() => void shareRequest(false)}>Copy the cancellation request</button>
        <button className="secondary" onClick={() => void shareRequest(true)}>{qr ? "Hide QR" : "Show QR"}</button>
      </div>
      {geometry ? <div className="recovery-share-qr">
        <svg viewBox={`0 0 ${geometry.size} ${geometry.size}`} width="220" height="220" role="img"
          aria-label="Cancellation request as a QR code">
          <rect width={geometry.size} height={geometry.size} fill="#ffffff" />
          <path d={geometry.path} fill="#000000" />
        </svg>
        <p className="form-note">The request carries no secret: it names the recovery to stop, and nothing else.</p>
      </div> : null}

      <GuardianInviteLinks account={account} chainId={chainId} />

      <div className="section-heading"><div><p className="eyebrow">Checked before it counts</p><h2>Collect their signatures</h2></div></div>
      <p>
        A guardian can hand their signature over privately, or publish it on chain so it can be picked up without
        reaching you. Both routes reach the same signature and can be mixed freely.
      </p>
      <div className="guardian-actions">
        <button className="secondary" onClick={() => void collectFromChain()}>Collect published cancellations</button>
      </div>
      {boardMessage && <p className="form-note" role="status">{boardMessage}</p>}
      {fromBoard.length > 0 && <ul>
        {fromBoard.map(entry => <li key={entry.guardianLeaf} className="breakable">
          {entry.guardianLeaf.slice(0, 14)}… · {entry.confirmed ? "confirmed" : "recent, may still reorganise"}
        </li>)}
      </ul>}
      {pastedFromLink && !pasted && <p className="callout" role="status">
        A guardian signature arrived with this link. Add it below to count it.
      </p>}
      <label className="field">
        <span>Guardian cancellation signature</span>
        <textarea
          rows={6}
          value={pasted || pastedFromLink}
          onChange={event => setPasted(event.target.value.slice(0, 20_000))}
          placeholder={'{"format":"loom.recovery-cancel-response",…} or a bearer link'}
        />
      </label>
      <div className="guardian-actions">
        <button className="secondary" onClick={() => void addResponse()} disabled={(pasted || pastedFromLink).trim().length === 0}>Verify and add signature</button>
      </div>
      {message ? <Callout live>{<p>{message}</p>}</Callout> : null}
      {clipboard.message ? <Callout tone={clipboard.failed ? "warning" : "neutral"} live><p>{clipboard.message}</p></Callout> : null}

      {cancelCalls ? <>
        <div className="section-heading"><div><p className="eyebrow">The signatures authorise it, not the sender</p><h2>Send it</h2></div></div>

        {/* Whichever route the collected signatures satisfy, this wallet can be
            the one that sends it. The account route must be sent by the account
            because the manager checks the sender; the guardian-only route may be
            sent by anyone, and "anyone" includes this wallet. Offering only the
            copied transaction there left someone holding a sufficient set of
            signatures with no way to use them. */}
        {ready ? <div className="callout warning">
          <strong>
            {ready === "account-and-guardians"
              ? "Enough signatures for the route that uses this wallet."
              : "Enough guardian signatures to stop this without the account."}
          </strong>
          <p>
            {ready === "account-and-guardians"
              ? "The manager checks that the account itself made the call, so this wallet sends it. The guardian signatures are what authorise the cancellation."
              : "Anyone with gas may send this one; this wallet is simply the one at hand. Sending it authorises nothing — the guardian signatures do."}
          </p>
          <div className="guardian-actions">
            <button className="primary" onClick={() => void cancelWithThisWallet(ready)} disabled={busy}>
              {busy ? "Submitting…" : "Stop this recovery with this wallet"}
            </button>
            <button className="secondary" onClick={() => void copyCall()} disabled={busy}>Copy exact transaction</button>
          </div>
        </div> : <p className="form-note">
          {seatsFilled} signature{seatsFilled === 1 ? "" : "s"} collected. This needs {shown.routes[1]!.guardiansNeeded} guardian
          {shown.routes[1]!.guardiansNeeded === 1 ? "" : "s"} without the account
          {shown.routes[0]!.available ? `, or this wallet plus ${shown.routes[0]!.guardiansNeeded}` : ""}.
        </p>}
        {sent ? <p className="callout success breakable">Submitted: {sent}</p> : null}
      </> : null}

      <p className="form-note">
        This request expires in {humanDuration(BigInt(state.request.expiresAt) - BigInt(Math.floor(Date.now() / 1000)))},
        and never outlives the recovery it stops.
      </p>
      <div className="guardian-actions"><button className="secondary" onClick={onClose}>Back to the wallet</button></div>
    </section>
  </main>;
}
