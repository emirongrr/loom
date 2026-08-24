import { useState } from "react";
import { P256RecoveryValidatorFactoryAbi } from "@loom/core/abi";
import { recoveryApprovalFromResponse, serializeRecoveryProtocol, type GuardianInviteV1, type RecoveryRequestV1, type RecoveryResponseV1 } from "@loom/sdk/recovery";
import { keccak256 } from "viem";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import type { AccountHandle } from "../../types";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import { createAccountGuardianClient } from "../security/guardianClient";
import { submitAccountCalls } from "../wallet/accountClient";
import { guardianCapabilityMatchesAccount, signGuardianDigestWithPasskey } from "./freezeSigning";
import { createGuardianRecoveryResponse, prepareGuardianRecoveryReview, type GuardianRecoveryReview } from "../recovery/recoveryApproval";
import { publishApproval } from "../recovery/recoveryCalls";
import { safeUserMessage } from "../../domain/errors/appError";
import { Dialog } from "../../components/Dialog";

const GuardianVerifierAbi = [{ type: "function", name: "verify", stateMutability: "view", inputs: [{ name: "keyCommitment", type: "bytes32" }, { name: "digest", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bool" }] }] as const;

export function RecoveryApprovalDialog({ request, capability, deployment, guardianAccount, alreadyPublished = false, onClose }: {
  readonly request: RecoveryRequestV1;
  readonly capability: GuardianInviteV1;
  readonly deployment: WalletDeployment;
  readonly guardianAccount: AccountHandle;
  readonly alreadyPublished?: boolean;
  readonly onClose: () => void;
}) {
  const { config } = useNetwork();
  const { publicClients, runtime, pendingOperations } = useAppServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<RecoveryResponseV1 | null>(null);
  const [review, setReview] = useState<GuardianRecoveryReview | null>(null);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [published, setPublished] = useState("");
  const canApprove = capability.guardian.kind === "p256" && guardianCapabilityMatchesAccount(capability, guardianAccount);
  const board = deployment.recoveryIntentBoard;

  const approve = async () => {
    setBusy(true); setError("");
    try {
      if (!deployment.recoveryModule || !deployment.recoveryValidatorProvisioner || deployment.chainId !== request.chainId || deployment.recoveryModule.toLowerCase() !== request.recoveryManager.toLowerCase()) throw new Error("This deployment cannot verify the recovery request.");
      const client = createAccountGuardianClient({ config, chainId: request.chainId, account: request.account, recoveryManager: request.recoveryManager, publicClients, recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner, policyHook: deployment.policyHook });
      const live = await client.inspectAccount();
      if (!live.recoveryConfigured) throw new Error("The protected account no longer has guardian recovery.");
      const prepared = prepareGuardianRecoveryReview({ request, capability, live: { guardianRoot: live.guardianRoot, guardianThreshold: live.guardianThreshold, configVersion: live.configVersion, validators: live.validators } });
      const publicClient = publicClients.forEndpoint(config.rpcUrl);
      const predicted = await publicClient.readContract({ address: deployment.recoveryValidatorProvisioner.address, abi: P256RecoveryValidatorFactoryAbi, functionName: "getAddress", args: [request.account, BigInt(request.nonce), request.initDataHash, request.newGuardianRoot, request.newGuardianThreshold] });
      if (predicted.toLowerCase() !== request.newValidator.toLowerCase()) throw new Error("The new validator is not the factory address committed by this request.");
      const [validatorCode, verifierCode] = await Promise.all([publicClient.getCode({ address: request.newValidator }), publicClient.getCode({ address: capability.guardian.verifier })]);
      if (!validatorCode || validatorCode === "0x" || keccak256(validatorCode) !== deployment.recoveryValidatorProvisioner.validatorRuntimeCodeHash) throw new Error("The proposed validator bytecode is not trusted.");
      if (!verifierCode || verifierCode === "0x" || keccak256(verifierCode) !== capability.guardian.verifierCodeHash) throw new Error("Your guardian verifier bytecode changed.");
      const signature = await signGuardianDigestWithPasskey({ capability, account: guardianAccount, digest: prepared.digest });
      const valid = await publicClient.readContract({ address: capability.guardian.verifier, abi: GuardianVerifierAbi, functionName: "verify", args: [capability.guardian.keyCommitment, prepared.digest, signature] });
      if (!valid) throw new Error("The guardian verifier rejected this passkey signature.");
      setReview(prepared);
      setResponse(createGuardianRecoveryResponse({ review: prepared, signature, signedAt: Math.floor(Date.now() / 1000) }));
    } catch (issue) { setError(safeUserMessage(issue, "Recovery approval could not be created. Recheck the live guardian state and try again.", "preparation")); }
    finally { setBusy(false); }
  };

  const publishCalldata = () => {
    if (!response || !review || !board) return null;
    return publishApproval({
      board,
      account: request.account,
      recoveryManager: request.recoveryManager,
      oldValidatorsHash: review.oldValidatorsHash,
      newValidator: request.newValidator,
      initDataHash: request.initDataHash,
      newGuardianRoot: request.newGuardianRoot,
      newGuardianThreshold: request.newGuardianThreshold,
      approval: recoveryApprovalFromResponse(response)
    }).data;
  };

  const publish = async () => {
    const data = publishCalldata();
    if (!data || !board) return;
    setBusy(true); setError("");
    try {
      const result = await submitAccountCalls({
        config, account: guardianAccount, deployment,
        calls: [{ target: board, value: 0n, data }],
        pendingOperations, runtime, publicClients
      });
      setPublished(result.transactionHash ?? result.userOpHash);
      setConfirmingPublish(false);
    } catch (issue) { setError(safeUserMessage(issue, "The approval could not be published. Your signature is unchanged and can still be shared privately.", "submission")); }
    finally { setBusy(false); }
  };

  const copyJson = async () => {
    if (!response) return;
    try { await navigator.clipboard.writeText(serializeRecoveryProtocol(response)); setError("Guardian response copied. Return it to the recovering device."); }
    catch { setError("Clipboard access is unavailable."); }
  };
  const copyLink = async () => {
    if (!response) return;
    try {
      const delivered = await createEncryptedLinkTransport<RecoveryResponseV1>({ origin: window.location.origin, path: "/recover" }).deliver(response, { expiresAt: response.expiresAt });
      await navigator.clipboard.writeText(delivered.value); setError("Guardian response bearer link copied. Anyone with the link can read the response; return it over a trusted channel.");
    } catch { setError("Response link could not be copied."); }
  };
  const copyPublishTransaction = async () => {
    const data = publishCalldata();
    if (!data || !board) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ chainId: request.chainId, to: board, data, value: "0x0" }, null, 2));
      setError("Exact publication transaction copied. Anyone may submit it; it grants them no authority.");
    } catch { setError("Clipboard access is unavailable."); }
  };

  return <Dialog label="Approve recovery" busy={busy} onClose={onClose}>
    <div className="sheet-handle" aria-hidden="true" />
    <p className="eyebrow">Guardian approval · code {request.humanCode}</p><h2>Review account recovery</h2>
    <p className="breakable">Protected account {request.account}</p>
    <div className="review-summary"><div><span>New validator</span><strong className="breakable">{request.newValidator}</strong></div><div><span>Config version</span><strong>{request.configVersion}</strong></div><div><span>Approvals required</span><strong>{request.guardianThreshold}</strong></div><div><span>Request expires</span><strong>{new Date(request.expiresAt * 1000).toLocaleString()}</strong></div></div>
    <p className="callout warning">Approval helps transfer complete control after the three-day on-chain delay. Compare code {request.humanCode} with the recovering person over an independent channel.</p>
    {alreadyPublished && <p className="callout">You have already published an approval for this request on chain.</p>}
    {!canApprove && <p className="callout warning">This capability is not a direct P-256 guardian for the open Loom wallet. If it came from the legacy ERC-1271 path, the account owner must remove the guardian and add the same address again through the delayed guardian-change flow before it can approve recovery.</p>}
    {error && <p className="callout" role="status">{error}</p>}

    {!response ? <div className="sheet-actions"><button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>{canApprove && <button className="primary" onClick={() => void approve()} disabled={busy}>{busy ? "Verifying live state…" : "Approve with guardian passkey"}</button>}</div>
      : <>
        <p className="callout success">The guardian verifier accepted your signature. Nothing has been published yet — choose how to return it.</p>

        <section className="section-card" aria-labelledby="share-privately-heading">
          <div className="section-heading"><div><p className="eyebrow">Recommended</p><h3 id="share-privately-heading">Share privately</h3></div><span className="pill">No gas · nothing on chain</span></div>
          <p className="form-note">Return the signed response over a channel you trust. Your guardian identity stays off chain until recovery actually executes.</p>
          <div className="guardian-actions"><button className="secondary" onClick={() => void copyJson()} disabled={busy}>Copy response JSON</button><button className="primary" onClick={() => void copyLink()} disabled={busy}>Copy response bearer link</button></div>
        </section>

        <section className="section-card" aria-labelledby="publish-heading">
          <div className="section-heading"><div><p className="eyebrow">Optional</p><h3 id="publish-heading">Publish on chain</h3></div><span className="pill failed">Permanent · costs gas</span></div>
          {published
            ? <p className="callout success">Approval published. <span className="breakable">{published}</span></p>
            : !board
              ? <p className="form-note">This deployment publishes no recovery intent board, so on-chain publication is unavailable. Sharing privately works normally.</p>
              : !confirmingPublish
                ? <>
                  <p className="form-note">Publishing lets anyone collect your approval without contacting you, which helps when the recovering person cannot reach every guardian.</p>
                  <div className="guardian-actions"><button className="secondary" onClick={() => setConfirmingPublish(true)} disabled={busy}>Review publishing…</button></div>
                </>
                : <>
                  <p className="callout warning"><strong>This cannot be undone.</strong> Publishing reveals that you are a guardian of this account, permanently and publicly. Today that disclosure happens only when recovery completes, and the guardian set is replaced in the same transaction. If this recovery is cancelled or abandoned, the guardian set is <em>not</em> replaced and you stay exposed against a set that is still in use.</p>
                  <p className="form-note">Your wallet pays the gas. Publishing grants no authority to anyone, including you: the recovery still needs {request.guardianThreshold} approvals, the on-chain delay, and a separate execution step.</p>
                  <div className="guardian-actions"><button className="secondary" onClick={() => setConfirmingPublish(false)} disabled={busy}>Keep it private</button><button className="secondary" onClick={() => void copyPublishTransaction()} disabled={busy}>Copy exact transaction</button><button className="danger-button" onClick={() => void publish()} disabled={busy}>{busy ? "Confirm on your device…" : "Publish approval on chain"}</button></div>
                </>}
        </section>

        <div className="sheet-actions"><span /><button className="secondary" onClick={onClose} disabled={busy}>Done</button></div>
      </>}
  </Dialog>;
}
