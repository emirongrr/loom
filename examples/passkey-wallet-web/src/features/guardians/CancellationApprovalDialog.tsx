import { useEffect, useState } from "react";
import { encodeFunctionData } from "viem";
import { RecoveryIntentBoardAbi } from "@loom/core/abi";
import {
  cancelApprovalFromResponse, serializeRecoveryProtocol,
  type CancelRequestV1, type CancelResponseV1, type GuardianInviteV1
} from "@loom/sdk/recovery";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import type { AccountHandle } from "../../types";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import { createAccountGuardianClient } from "../security/guardianClient";
import { guardianCapabilityMatchesAccount, signGuardianDigestWithPasskey } from "./freezeSigning";
import { submitAccountCalls } from "../wallet/accountClient";
import { createGuardianCancellationResponse, prepareGuardianCancellationReview } from "../recovery/cancellationApproval";
import { cancellationQuorum } from "../recovery/cancellationQuorum.ts";
import { boardSupportsCancellation } from "./boardCapabilities.ts";
import { safeUserMessage } from "../../domain/errors/appError";
import { Dialog } from "../../components/Dialog";
import { Callout } from "../../components/Callout";
import { useClipboard } from "../../components/useClipboard";

const GuardianVerifierAbi = [{
  type: "function", name: "verify", stateMutability: "view",
  inputs: [{ name: "keyCommitment", type: "bytes32" }, { name: "digest", type: "bytes32" }, { name: "signature", type: "bytes" }],
  outputs: [{ name: "", type: "bool" }]
}] as const;

/**
 * A guardian signing to stop a recovery.
 *
 * Read in red throughout, because this is the opposite of the approval sheet
 * that looks almost exactly like it. A guardian working through several
 * requests should never have to re-read the heading to know which way they are
 * about to sign.
 *
 * Stopping is not the safe default. Refusing a genuine recovery strands the
 * account's owner, which is the failure guardians exist to prevent, so the
 * sheet says who is asking and what happens if they are wrong.
 */
export function CancellationApprovalDialog({ request, capability, deployment, guardianAccount, onClose }: {
  readonly request: CancelRequestV1;
  readonly capability: GuardianInviteV1;
  readonly deployment: WalletDeployment;
  readonly guardianAccount: AccountHandle;
  readonly onClose: () => void;
}) {
  const { config } = useNetwork();
  const { publicClients, runtime, pendingOperations } = useAppServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<CancelResponseV1 | null>(null);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [published, setPublished] = useState("");
  // Kept apart from `error`, which renders at the top of the sheet. A failure
  // reported three screens above the button that caused it reads as the button
  // doing nothing at all.
  const [publishMessage, setPublishMessage] = useState("");
  const clipboard = useClipboard();
  const board = deployment.recoveryIntentBoard;
  // "unknown" until the chain answers. Offering a button whose only outcome is
  // a bundler refusing to estimate gas is worse than offering nothing.
  const [boardTakesCancellations, setBoardTakesCancellations] = useState<"unknown" | "yes" | "no">("unknown");

  useEffect(() => {
    if (!board) return;
    let cancelled = false;
    void (async () => {
      try {
        const code = await publicClients.forEndpoint(config.rpcUrl).getCode({ address: board });
        if (!cancelled) setBoardTakesCancellations(boardSupportsCancellation(code) ? "yes" : "no");
      } catch {
        // Unreadable is not "unsupported": leave it unknown and let the call
        // itself be the authority, as it was before this check existed.
        if (!cancelled) setBoardTakesCancellations("unknown");
      }
    })();
    return () => { cancelled = true; };
  }, [board, config.rpcUrl, publicClients]);
  const canSign = capability.guardian.kind === "p256" && guardianCapabilityMatchesAccount(capability, guardianAccount);

  const sign = async () => {
    setBusy(true); setError("");
    try {
      if (!deployment.recoveryModule
        || deployment.chainId !== request.chainId
        || deployment.recoveryModule.toLowerCase() !== request.recoveryManager.toLowerCase()) {
        throw new Error("This deployment cannot verify the cancellation request.");
      }
      const client = createAccountGuardianClient({
        config, chainId: request.chainId, account: request.account,
        recoveryManager: request.recoveryManager, publicClients
      });
      const [live, pending] = await Promise.all([client.inspectAccount(), client.readPendingRecovery()]);
      if (!live.recoveryConfigured) throw new Error("The protected account no longer has guardian recovery.");

      const prepared = prepareGuardianCancellationReview({
        request, capability,
        live: {
          guardianRoot: live.guardianRoot,
          guardianThreshold: live.guardianThreshold,
          configVersion: live.configVersion,
          pending
        }
      });
      const publicClient = publicClients.forEndpoint(config.rpcUrl);
      const verifierCode = await publicClient.getCode({ address: capability.guardian.verifier });
      if (!verifierCode || verifierCode === "0x") throw new Error("Your guardian verifier has no code on this chain.");

      const signature = await signGuardianDigestWithPasskey({ capability, account: guardianAccount, digest: prepared.digest });
      const valid = await publicClient.readContract({
        address: capability.guardian.verifier, abi: GuardianVerifierAbi,
        functionName: "verify", args: [capability.guardian.keyCommitment, prepared.digest, signature]
      });
      if (!valid) throw new Error("The guardian verifier rejected this passkey signature.");
      setResponse(createGuardianCancellationResponse({ review: prepared, signature, signedAt: Math.floor(Date.now() / 1000) }));
    } catch (issue) {
      setError(safeUserMessage(issue, "The cancellation could not be signed. Recheck the live state and try again.", "preparation"));
    } finally { setBusy(false); }
  };

  /**
   * Publish this signature so it can be collected without reaching this device.
   *
   * The mirror of publishing an approval, and needed more here, not less: a
   * cancellation races a delay that is already running, so the route that does
   * not depend on one person being reachable is the one that decides whether a
   * quorum can act at all.
   *
   * It carries the same permanent cost as publishing an approval -- it reveals
   * that this wallet is a guardian of this account, publicly and for good.
   */
  const publishCalldata = () => {
    if (!response || !board) return null;
    const approval = cancelApprovalFromResponse(response);
    return encodeFunctionData({
      abi: RecoveryIntentBoardAbi,
      functionName: "publishCancellation",
      args: [request.account, request.recoveryManager, [{
        verifier: approval.verifier,
        keyCommitment: approval.keyCommitment,
        salt: approval.salt,
        signature: approval.signature,
        proof: approval.proof
      }]]
    });
  };

  const publish = async () => {
    setPublishMessage("");
    const data = publishCalldata();
    if (!data) { setPublishMessage("There is no signature to publish yet."); return; }
    if (!board) { setPublishMessage("This deployment publishes no recovery intent board."); return; }
    setBusy(true);
    try {
      const result = await submitAccountCalls({
        config, account: guardianAccount, deployment,
        calls: [{ target: board, value: 0n, data }],
        pendingOperations, runtime, publicClients
      });
      setPublished(result.transactionHash ?? result.userOpHash);
      setConfirmingPublish(false);
    } catch (issue) {
      setPublishMessage(safeUserMessage(issue, "The cancellation could not be published. Your signature is unchanged and can still be shared privately.", "submission"));
    } finally { setBusy(false); }
  };

  const copyPublishTransaction = async () => {
    const data = publishCalldata();
    if (!data || !board) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ chainId: request.chainId, to: board, data, value: "0x0" }, null, 2));
      setPublishMessage("Exact publication transaction copied. Anyone may submit it; it grants them no authority.");
    } catch { setPublishMessage("Clipboard access is unavailable."); }
  };

  const copyJson = async () => {
    if (!response) return;
    await clipboard.copy(serializeRecoveryProtocol(response), {
      what: "Cancellation signature",
      fallback: "Copy the bearer link instead."
    });
  };

  const copyLink = async () => {
    if (!response) return;
    try {
      // Aimed at the page that can actually use it. "/recover" is where a
      // guardian's *approval* goes, and that page only knows how to read a
      // recovery response -- a cancellation signature arriving there is
      // refused, correctly, by a screen that cannot say what to do instead.
      const delivered = await createEncryptedLinkTransport<CancelResponseV1>({ origin: window.location.origin, path: "/recover/stop" })
        .deliver(response, { expiresAt: response.expiresAt });
      await navigator.clipboard.writeText(delivered.value);
      setError("Bearer link copied. Anyone with the link can read the signature; return it over a trusted channel.");
    } catch { setError("The link could not be copied."); }
  };

  return <Dialog label="Stop a recovery" busy={busy} onClose={onClose}>
    <div className="sheet-handle" aria-hidden="true" />
    <p className="eyebrow">Guardian cancellation · code {request.humanCode}</p>
    <h2>Stop an account recovery</h2>
    <p className="breakable">Protected account {request.account}</p>

    <div className="review-summary">
      <div><span>Recovery being stopped</span><strong className="breakable">{request.recoveryId.slice(0, 18)}…</strong></div>
      <div><span>Config version</span><strong>{request.configVersion}</strong></div>
      <div><span>Guardian threshold</span><strong>{request.guardianThreshold}</strong></div>
      <div><span>Request expires</span><strong>{new Date(request.expiresAt * 1000).toLocaleString()}</strong></div>
    </div>

    <div className="removal-confirmation">
      <div className="removal-warning">
        <span aria-hidden="true">!</span>
        <div>
          <strong>This is the opposite of approving a recovery.</strong>
          <p>
            Your signature helps cancel the recovery of this account. If the recovery is genuine, cancelling it
            strands the owner — which is the failure guardians exist to prevent. Confirm with the account owner over
            an independent channel, comparing code {request.humanCode}, before you sign.
          </p>
        </div>
      </div>
    </div>

    <p className="form-note">
      {capitalise(cancellationQuorum(request.guardianThreshold).sentence.replace("this wallet", "the account"))}. Your signature alone stops nothing, and it is checked
      against live guardian state before it counts.
    </p>

    {!canSign && <p className="callout warning">
      This capability is not a direct P-256 guardian for the open Loom wallet, so it cannot sign a cancellation.
    </p>}
    {error && <Callout tone="warning" live><p>{error}</p></Callout>}
    {clipboard.message && <Callout tone={clipboard.failed ? "warning" : "success"} live><p>{clipboard.message}</p></Callout>}

    {!response
      ? <div className="sheet-actions">
        <button className="secondary" onClick={onClose} disabled={busy}>Back</button>
        {canSign && <button className="danger-button" onClick={() => void sign()} disabled={busy}>
          {busy ? "Verifying live state…" : "Sign to stop this recovery"}
        </button>}
      </div>
      : <>
        <p className="callout success">
          The guardian verifier accepted your signature. Nothing is on chain: a cancellation is only submitted by the
          person collecting the signatures.
        </p>
        <section className="section-card" aria-labelledby="return-cancellation-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Recommended</p><h3 id="return-cancellation-heading">Send your signature back</h3></div>
            <span className="pill">No gas · nothing on chain</span>
          </div>
          <p className="form-note">
            Return it over a channel you trust. Your guardian identity stays off chain.
          </p>
          <div className="guardian-actions">
            <button className="secondary" onClick={() => void copyJson()} disabled={busy}>Copy signature JSON</button>
            <button className="primary" onClick={() => void copyLink()} disabled={busy}>Copy bearer link</button>
          </div>
        </section>

        <section className="section-card" aria-labelledby="publish-cancellation-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Optional</p><h3 id="publish-cancellation-heading">Publish on chain</h3></div>
            <span className="pill failed">Permanent · costs gas</span>
          </div>
          {published
            ? <p className="callout success">Cancellation published. <span className="breakable">{published}</span></p>
            : !board
              ? <p className="form-note">This deployment publishes no recovery intent board, so on-chain publication is unavailable. Sharing privately works normally.</p>
              : boardTakesCancellations === "no"
                ? <p className="callout warning">
                  <strong>This chain&apos;s board predates published cancellations.</strong> The deployed contract has no
                  function to accept one, so submitting would only spend gas to be rejected. Return your signature
                  privately instead — that route is complete and needs no board at all.
                </p>
                : boardTakesCancellations === "unknown"
                  ? <p className="form-note">Checking whether this chain&apos;s board accepts published cancellations…</p>
                  : !confirmingPublish
                ? <>
                  <p className="form-note">
                    Publishing lets the signatures accumulate on chain, so a quorum can be assembled without every
                    guardian reaching the same device. A cancellation races a delay that is already running, which is
                    exactly when reaching people is hardest.
                  </p>
                  <div className="guardian-actions">
                    <button className="secondary" onClick={() => setConfirmingPublish(true)} disabled={busy}>Review publishing…</button>
                  </div>
                  {publishMessage && <p className="callout" role="status">{publishMessage}</p>}
                </>
                : <>
                  <p className="callout warning">
                    <strong>This cannot be undone.</strong> Publishing reveals that you are a guardian of this account,
                    permanently and publicly — and unlike a recovery that completes, a cancelled recovery does
                    <em> not</em> replace the guardian set, so you stay exposed against a set that is still in use.
                  </p>
                  <p className="form-note">
                    Your wallet pays the gas. Publishing grants no authority to anyone — cancelling still means {cancellationQuorum(request.guardianThreshold).sentence.replace("this wallet", "the account")},
                    and the manager re-verifies every signature.
                  </p>
                  <div className="guardian-actions">
                    <button className="secondary" onClick={() => setConfirmingPublish(false)} disabled={busy}>Keep it private</button>
                    <button className="secondary" onClick={() => void copyPublishTransaction()} disabled={busy}>Copy exact transaction</button>
                    <button className="danger-button" onClick={() => void publish()} disabled={busy}>
                      {busy ? "Confirm on your device…" : "Publish cancellation on chain"}
                    </button>
                  </div>
                  {publishMessage && <p className="callout" role="status">{publishMessage}</p>}
                </>}
        </section>
        <div className="sheet-actions"><span /><button className="secondary" onClick={onClose} disabled={busy}>Done</button></div>
      </>}
  </Dialog>;
}

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
