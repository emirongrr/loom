import { useState } from "react";
import { keccak256, encodeAbiParameters } from "viem";
import {
  createRecoveryProposalDigest, createRecoverySignature, parseRecoveryRequest, serializeRecoveryProtocol,
  type RecoveryRequestV1
} from "@loom/sdk/recovery";
import { useNetwork } from "../../config/NetworkContext";
import { useAppServices } from "../../app/AppServices";
import { createAccountGuardianClient } from "../security/guardianClient";
import { loadWalletDeployment } from "../onboarding/accountLifecycle";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import { signRecoveryDigestWithOwnPasskey } from "./freezeSigning";
import type { AccountHandle } from "../../types";

/**
 * Approve a recovery holding nothing but this wallet's own passkey.
 *
 * A full guardian response carries a leaf, verifier, key commitment, salt and
 * Merkle proof, all of which come from an invitation. Requiring them made an
 * invitation a precondition for helping, and committing a guardian set on chain
 * reaches nobody, so guardians routinely have none.
 *
 * None of those five are this wallet's to know. They describe membership of a
 * set the recovering party holds, and they authorise nothing; the signature
 * does. So this produces only the signature, and the recovering wallet matches
 * it against its own roster.
 *
 * Whether it counts is not decided here and cannot be. A signature verifies
 * against a leaf in the account's live guardian root or it matches nothing at
 * all -- there is no state on the other side to poison, which is why an
 * unauthorised signature is simply worthless rather than dangerous.
 */
export function SignWithoutInvitation({ account }: { readonly account: AccountHandle }) {
  const { config } = useNetwork();
  const services = useAppServices();
  const [artifact, setArtifact] = useState("");
  const [signed, setSigned] = useState("");
  const [request, setRequest] = useState<RecoveryRequestV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const sign = async () => {
    setBusy(true); setMessage(""); setSigned("");
    try {
      const parsed = artifact.trim().startsWith("{")
        ? parseRecoveryRequest(artifact)
        : parseRecoveryRequest(await createEncryptedLinkTransport<RecoveryRequestV1>({
          origin: window.location.origin, path: "/guardian"
        }).receive(artifact));

      const deployment = await loadWalletDeployment();
      await services.runtime.verify(config, deployment);
      if (deployment.chainId !== parsed.chainId) throw new Error("That recovery request is for another chain.");
      if (!deployment.recoveryModule || deployment.recoveryModule.toLowerCase() !== parsed.recoveryManager.toLowerCase()) {
        throw new Error("That recovery request names a recovery manager this build does not recognise.");
      }

      // The digest is recomputed from live state rather than taken from the
      // request: signing what someone else calculated would be signing a claim,
      // not a fact. The account's own validators are what the manager will
      // check the proposal against.
      const client = createAccountGuardianClient({
        config, chainId: deployment.chainId, account: parsed.account,
        recoveryManager: deployment.recoveryModule, publicClients: services.publicClients,
        recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner,
        policyHook: deployment.policyHook
      });
      const live = await client.inspectAccount();
      if (live.configVersion.toString() !== parsed.configVersion) {
        throw new Error("The account configuration changed after this request was made. It has to be created again.");
      }
      if (live.guardianRoot !== parsed.guardianRoot) {
        throw new Error("The account's guardian set changed after this request was made. It has to be created again.");
      }
      const digest = createRecoveryProposalDigest({
        account: parsed.account,
        oldValidatorsHash: keccak256(encodeAbiParameters([{ type: "address[]" }], [[...live.validators]])),
        newValidator: parsed.newValidator,
        initDataHash: parsed.initDataHash,
        newGuardianRoot: parsed.newGuardianRoot,
        newGuardianThreshold: parsed.newGuardianThreshold,
        configVersion: live.configVersion,
        nonce: parsed.nonce,
        chainId: deployment.chainId,
        recoveryManager: deployment.recoveryModule
      });

      const signature = await signRecoveryDigestWithOwnPasskey({ account, digest });
      setRequest(parsed);
      setSigned(serializeRecoveryProtocol(createRecoverySignature({
        requestId: parsed.requestId,
        chainId: parsed.chainId,
        account: parsed.account,
        recoveryDigest: digest,
        signature,
        signedAt: Math.floor(services.now() / 1000),
        expiresAt: parsed.expiresAt
      })));
      setMessage("Signed. Return this to the person recovering the account; it is worth nothing to anyone else.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request could not be signed.");
    } finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(signed); setMessage("Signature copied."); }
    catch { setMessage("The browser would not copy it. Select the text and copy it manually."); }
  };

  return <section className="section-card" aria-labelledby="sign-without-invitation">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Guardian recovery</p>
        <h2 id="sign-without-invitation">Sign without an invitation</h2>
      </div>
      <span className="pill">No gas</span>
    </div>
    <p>
      If you know you are a guardian for this account but were never sent an invitation, you can still approve.
      This signs the recovery with this wallet's passkey and returns the signature alone; the person recovering
      the account supplies the rest from their own guardian list.
    </p>
    <p className="form-note">
      Check the six-digit code with them over a channel you trust before signing. A signature from someone who is
      not a guardian of this account matches nothing and is simply discarded.
    </p>

    <label className="field"><span>Recovery request or bearer link</span>
      <textarea rows={5} value={artifact} disabled={busy} onChange={event => setArtifact(event.target.value)}
        placeholder='{"format":"loom.recovery-request",…}' />
    </label>
    <button className="primary" disabled={busy || !artifact.trim()} onClick={() => void sign()}>
      {busy ? "Reading live state…" : "Review and sign"}
    </button>

    {message && <p className="callout" role="status">{message}</p>}

    {signed && request && <div className="callout success">
      <strong>Signed recovery {request.humanCode}</strong>
      <p className="breakable">Account {request.account} · new validator {request.newValidator}</p>
      <p className="breakable form-note">{signed}</p>
      <button className="secondary" onClick={() => void copy()}>Copy signature</button>
    </div>}
  </section>;
}
