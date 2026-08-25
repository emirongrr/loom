import { useEffect, useState } from "react";
import { parseRecoveryResponse, serializeRecoveryProtocol, type GuardianApprovalTuple, type RecoveryRequestV1 } from "@loom/sdk/recovery";
import { type Hex } from "viem";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { loadWalletDeployment } from "../onboarding/accountLifecycle";
import { createAccountGuardianClient } from "../security/guardianClient";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import { transitionRecoverySession, type RecoverySession, type RecoverySessionRepository } from "./recoverySession";
import { recoverySessionView } from "./recoverySessionView";
import { announceRecovery, oldValidatorsHash } from "./recoveryCalls";
import { CollectedFromChain, ExecutionReceipt, ImportResponse, PaidStep, ProposalReceipt, SendToGuardians } from "./RecoverySessionPanels";
import { sendEip1193Transaction, type Eip1193Provider } from "./recoveryPasskey";
import { createBrowserGuardianRoster } from "../../storage/guardianRoster";
import { planGuardianChange } from "../security/guardianPlan";
import { assertPendingRecoveryMatchesPrepared, assertPreparedRecoveryMatchesRequest, assertSuccessfulTransactionReceipt, restorePreparedRecovery, verifyRecoveryResponseForProposal } from "./recoveryProposal";
import type { AccountHandle } from "../../types";
import { recoveryGasPayers, selectRecoveryGasPayer } from "./recoveryGasPayer";
import { submitAccountCalls } from "../wallet/accountClient";
import { mergeApprovals, readBoardApprovals, type BoardApproval } from "./boardApprovals";
import { announceFailure, safeRecoveryMessage } from "./recoveryMessages.ts";
import { shortStage } from "./recoveryStage.ts";
import { shortAddress } from "../../components/address.ts";

/**
 * One saved recovery, from a signed request to a finished rotation.
 *
 * Lifted out of RecoveryPage, which held this and the session list in one
 * 1,167-line file. They share nothing but the repository they read from: this
 * one owns a single session's progress, the page owns which session is open.
 */
export function RecoveryProposalSessionView({ session, repository, accounts, onChanged, onRecovered, onBack }: {
  readonly session: RecoverySession;
  readonly repository: RecoverySessionRepository;
  readonly accounts: readonly AccountHandle[];
  readonly onChanged: () => Promise<void>;
  readonly onRecovered: (handle: AccountHandle) => Promise<void>;
  readonly onBack: () => void;
}) {
  const { config } = useNetwork();
  const { publicClients, runtime, pendingOperations } = useAppServices();
  // Announcing costs a transaction and grants nobody anything, so any wallet
  // can pay for it -- including one of this device's own. Requiring an injected
  // browser wallet was a wallet requirement, not a protocol one.
  const announcePayers = recoveryGasPayers(accounts, session.request.chainId, session.request.account);
  const [announcePayerId, setAnnouncePayerId] = useState("");
  const announcePayer = selectRecoveryGasPayer(announcePayers, announcePayerId);
  const [message, setMessage] = useState("");
  const [responseArtifact, setResponseArtifact] = useState("");
  const [busy, setBusy] = useState(false);
  // Approvals a guardian published on chain rather than sending privately.
  // Collecting by hand requires every guardian to reach one device, and that
  // device to still exist when the last of them does.
  const [published, setPublished] = useState<readonly BoardApproval[]>([]);
  const [boardMessage, setBoardMessage] = useState("");
  const [announced, setAnnounced] = useState<Hex | "">("");
  // Reported beside the button that produced it. Sending this to the board
  // panel's message meant a refusal -- no browser wallet, a session with no
  // stored validator set -- appeared in a different box, so pressing the button
  // looked like it did nothing at all.
  const [announceMessage, setAnnounceMessage] = useState("");
  // The link is generated on the device, never fetched, and only while the
  // request is still collecting. Rendering it as a QR is what makes handing it
  // to a guardian standing next to you possible at all.
  const [shareLink, setShareLink] = useState("");

  const rebuild = async (submitTransport?: Parameters<typeof createAccountGuardianClient>[0]["submitTransport"]) => {
    if (!session.local) throw new Error("This device has no encrypted execution material for this recovery request.");
    const deployment = await loadWalletDeployment();
    await runtime.verify(config, deployment);
    if (deployment.chainId !== session.request.chainId || deployment.recoveryModule?.toLowerCase() !== session.request.recoveryManager.toLowerCase()) {
      throw new Error("Recovery request does not match this deployment.");
    }
    const newGuardianSet = planGuardianChange({ current: [], next: session.local.freshGuardianEntries, threshold: session.request.newGuardianThreshold }).set;
    const client = createAccountGuardianClient({
      config, chainId: deployment.chainId, account: session.request.account, recoveryManager: session.request.recoveryManager, publicClients,
      recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner, policyHook: deployment.policyHook,
      ...(submitTransport ? { submitTransport } : {})
    });
    const prepared = await client.prepareRecovery({ newValidator: session.request.newValidator, initData: session.local.initData, newGuardianSet });
    assertPreparedRecoveryMatchesRequest(prepared, session.request);
    return { client, prepared };
  };

  const restorePending = async (submitTransport?: Parameters<typeof createAccountGuardianClient>[0]["submitTransport"]) => {
    if (!session.local?.oldValidators) throw new Error("This recovery session predates executable validator-set storage. Create a fresh recovery request.");
    const deployment = await loadWalletDeployment();
    await runtime.verify(config, deployment);
    if (deployment.chainId !== session.request.chainId || deployment.recoveryModule?.toLowerCase() !== session.request.recoveryManager.toLowerCase()) {
      throw new Error("Recovery request does not match this deployment.");
    }
    const newGuardianSet = planGuardianChange({ current: [], next: session.local.freshGuardianEntries, threshold: session.request.newGuardianThreshold }).set;
    const client = createAccountGuardianClient({
      config, chainId: deployment.chainId, account: session.request.account, recoveryManager: session.request.recoveryManager, publicClients,
      recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner, policyHook: deployment.policyHook,
      ...(submitTransport ? { submitTransport } : {})
    });
    const prepared = restorePreparedRecovery({ request: session.request, initData: session.local.initData, oldValidators: session.local.oldValidators, newGuardianSet });
    return { client, prepared };
  };

  const saveRecoveredWallet = async () => {
    if (!session.local) throw new Error("Recovered passkey metadata is unavailable on this device.");
    const handle: AccountHandle = Object.freeze({
      version: 1,
      kind: "recovered",
      id: `${session.request.chainId}:${session.request.account.toLowerCase()}`,
      label: "Recovered wallet",
      account: session.request.account,
      chainId: session.request.chainId,
      credentialId: session.local.credentialId,
      publicKey: session.local.publicKey,
      rpId: session.local.rpId,
      origin: session.local.origin,
      validator: session.request.newValidator
    });
    await createBrowserGuardianRoster().write(handle.id, { entries: session.local.freshGuardianEntries, version: Date.now(), pending: null });
    await onRecovered(handle);
  };

  const checkPending = async () => {
    setBusy(true); setMessage("");
    try {
      const context = await restorePending();
      const pending = await context.client.readPendingRecovery();
      if (pending.pending) assertPendingRecoveryMatchesPrepared(pending, context.prepared);
      if (pending.status === "ready" && session.stage === "delay-active") {
        await repository.write(transitionRecoverySession(session, { type: "chain-ready" }));
        await onChanged();
        setMessage("The on-chain recovery delay has completed. Execution is ready.");
      } else if (pending.status === "expired") {
        await repository.write(transitionRecoverySession(session, { type: "expired" }));
        await onChanged();
        setMessage("The on-chain recovery execution window expired.");
      } else if (pending.status === "delay-active") {
        setMessage(`The contract delay is still active until ${new Date(Number(pending.readyAt * 1_000n)).toLocaleString()}.`);
      } else if (!pending.pending) {
        setMessage("No matching pending recovery exists on chain.");
      }
    } catch (error) { setMessage(safeRecoveryMessage(error)); }
    finally { setBusy(false); }
  };

  /**
   * Execute, paying from one of this device's own Loom wallets.
   *
   * Execution needs no session and no passkey (ADR-0025): the validator was
   * initialized when it was deployed, so the call carries no initializer and
   * anyone with gas can finish an approved, matured recovery. The account being
   * recovered is still excluded -- it is about to have its validator set
   * replaced, and its current key may be the thing that is lost.
   */
  const executeWithLoomWallet = async () => {
    if (!announcePayer) { setMessage("Choose a saved Loom wallet to pay for the execution."); return; }
    setBusy(true); setMessage("");
    try {
      const deployment = await loadWalletDeployment();
      await runtime.verify(config, deployment);
      let submitted: Hex | undefined;
      const submitTransport = {
        submit: async ({ to, data, value }: { to: `0x${string}`; data: `0x${string}`; value: bigint }) => {
          const result = await submitAccountCalls({
            config, account: announcePayer, deployment,
            calls: [{ target: to, data, value }],
            pendingOperations, runtime, publicClients
          });
          submitted = (result.transactionHash ?? result.userOpHash) as Hex;
          return submitted;
        }
      };
      const context = await restorePending(submitTransport);
      await context.client.executeRecovery(context.prepared);
      if (!submitted) throw new Error("The paying wallet returned no execution transaction hash.");
      // Read the account back rather than trusting the receipt: this is the
      // moment control actually moves, and the only acceptable outcome is the
      // exact validator and root that were reviewed.
      const live = await context.client.inspectAccount();
      if (live.validators.length !== 1 || live.validators[0]?.toLowerCase() !== session.request.newValidator.toLowerCase() || live.guardianRoot !== session.request.newGuardianRoot) {
        throw new Error("The execution did not produce the reviewed validator and guardian root.");
      }
      await repository.write(transitionRecoverySession(session, { type: "completed", transactionHash: submitted }));
      await onChanged();
      try {
        await saveRecoveredWallet();
        setMessage(`Recovery executed by ${announcePayer.label} and the new passkey wallet was saved: ${submitted}`);
      } catch {
        setMessage(`Recovery executed on chain: ${submitted}. Saving the recovered wallet failed; use Save recovered wallet to retry.`);
      }
    } catch (error) { setMessage(announceFailure(error)); }
    finally { setBusy(false); }
  };

  const execute = async () => {
    setBusy(true); setMessage("");
    try {
      const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
      if (!provider) throw new Error("No browser wallet is available to publish the permissionless execution transaction.");
      let executionHash: `0x${string}` | undefined;
      const submitTransport = {
        submit: async ({ to, data, value }: { to: `0x${string}`; data: `0x${string}`; value: bigint }) => {
          executionHash = await sendEip1193Transaction({ provider, chainId: session.request.chainId, to, data, value });
          assertSuccessfulTransactionReceipt(await publicClients.forEndpoint(config.rpcUrl).waitForTransactionReceipt({ hash: executionHash }));
          return executionHash;
        }
      };
      const context = await restorePending(submitTransport);
      await context.client.executeRecovery(context.prepared);
      if (!executionHash) throw new Error("The publishing wallet returned no execution transaction hash.");
      const live = await context.client.inspectAccount();
      if (live.validators.length !== 1 || live.validators[0]?.toLowerCase() !== session.request.newValidator.toLowerCase() || live.guardianRoot !== session.request.newGuardianRoot) {
        throw new Error("The execution receipt did not produce the reviewed validator and guardian root.");
      }
      const completed = transitionRecoverySession(session, { type: "completed", transactionHash: executionHash });
      await repository.write(completed);
      await onChanged();
      try {
        await saveRecoveredWallet();
        setMessage(`Recovery executed and the new passkey wallet was saved: ${executionHash}`);
      } catch {
        setMessage(`Recovery executed on chain: ${executionHash}. Saving the recovered wallet failed; use Save recovered wallet to retry.`);
      }
    } catch (error) { setMessage(safeRecoveryMessage(error)); }
    finally { setBusy(false); }
  };

  const verifyResponse = async (response: ReturnType<typeof parseRecoveryResponse>, context: Awaited<ReturnType<typeof rebuild>>): Promise<GuardianApprovalTuple> => {
    const publicClient = publicClients.forEndpoint(config.rpcUrl);
    return verifyRecoveryResponseForProposal({
      response, request: session.request, prepared: context.prepared,
      readCode: verifier => publicClient.getCode({ address: verifier }),
      verifySignature: input => context.client.verifyRecoveryApproval(context.prepared, input)
    });
  };

  const importResponse = async () => {
    setBusy(true); setMessage("");
    try {
      const payload = responseArtifact.trim().startsWith("{")
        ? JSON.parse(responseArtifact) as Record<string, unknown>
        : await createEncryptedLinkTransport<Record<string, unknown>>({ origin: window.location.origin, path: "/recover" }).receive(responseArtifact);
      const context = await rebuild();
      const response = parseRecoveryResponse(payload, session.request);
      await verifyResponse(response, context);
      const updated = transitionRecoverySession(session, { type: "response-added", response });
      await repository.write(updated);
      await onChanged();
      setResponseArtifact("");
      setMessage("Guardian response verified against live state and saved.");
    } catch (error) { setMessage(safeRecoveryMessage(error)); }
    finally { setBusy(false); }
  };

  /**
   * Propose, paying from one of this device's own Loom wallets.
   *
   * Proposing is permissionless: the submitter pays the fee and receives
   * nothing, which is why the account being recovered is the only wallet that
   * cannot do it -- its passkey may be the thing that is lost. Requiring an
   * injected browser wallet for a call any wallet may make was a wallet
   * requirement, not a protocol one.
   */
  const proposeWithLoomWallet = async () => {
    if (!announcePayer) { setMessage("Choose a saved Loom wallet to pay for the proposal."); return; }
    setBusy(true); setMessage("");
    try {
      const deployment = await loadWalletDeployment();
      await runtime.verify(config, deployment);
      let submitted: Hex | undefined;
      const submitTransport = {
        submit: async ({ to, data, value }: { to: `0x${string}`; data: `0x${string}`; value: bigint }) => {
          const result = await submitAccountCalls({
            config, account: announcePayer, deployment,
            calls: [{ target: to, data, value }],
            pendingOperations, runtime, publicClients
          });
          submitted = (result.transactionHash ?? result.userOpHash) as Hex;
          return submitted;
        }
      };
      const context = await rebuild(submitTransport);
      const collected: { leaf: `0x${string}`; approval: GuardianApprovalTuple }[] = [];
      for (const response of session.responses) {
        collected.push({ leaf: response.guardianLeaf, approval: await verifyResponse(response, context) });
      }
      const approvals = mergeApprovals({ collected, published });
      if (approvals.length < session.request.guardianThreshold) throw new Error("Guardian approval threshold has not been reached.");
      await context.client.proposeRecovery(context.prepared, approvals);
      if (!submitted) throw new Error("The paying wallet returned no proposal transaction hash.");
      const pending = await context.client.readPendingRecovery();
      assertPendingRecoveryMatchesPrepared(pending, context.prepared);
      if (pending.readyAt <= 0n || pending.expiresAt <= pending.readyAt) throw new Error("The proposal did not create a valid on-chain recovery window.");
      await repository.write(transitionRecoverySession(session, { type: "proposal-confirmed", transactionHash: submitted, readyAt: pending.readyAt, expiresAt: pending.expiresAt }));
      await onChanged();
      setMessage(`Recovery proposed by ${announcePayer.label}: ${submitted}`);
    } catch (error) { setMessage(announceFailure(error)); }
    finally { setBusy(false); }
  };

  const propose = async () => {
    setBusy(true); setMessage("");
    try {
      const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
      if (!provider) throw new Error("No browser wallet is available to publish the permissionless proposal transaction.");
      let transactionHash: `0x${string}` | undefined;
      const submitTransport = {
        submit: async ({ to, data, value }: { to: `0x${string}`; data: `0x${string}`; value: bigint }) => {
          transactionHash = await sendEip1193Transaction({ provider, chainId: session.request.chainId, to, data, value });
          assertSuccessfulTransactionReceipt(await publicClients.forEndpoint(config.rpcUrl).waitForTransactionReceipt({ hash: transactionHash }));
          return transactionHash;
        }
      };
      const context = await rebuild(submitTransport);
      const collected: { leaf: `0x${string}`; approval: GuardianApprovalTuple }[] = [];
      for (const response of session.responses) {
        const approval = await verifyResponse(response, context);
        collected.push({ leaf: response.guardianLeaf, approval });
      }
      // Both routes reach the same tuple, so a recovery can mix them. Nothing
      // read from the board is trusted: `proposeRecovery` rebuilds every leaf,
      // checks its proof against the account's live guardian root, and asks the
      // verifier contract about the signature, refusing the whole call if any
      // approval fails.
      const approvals = mergeApprovals({ collected, published });
      if (approvals.length < session.request.guardianThreshold) throw new Error("Guardian approval threshold has not been reached.");
      await context.client.proposeRecovery(context.prepared, approvals);
      if (!transactionHash) throw new Error("The publishing wallet returned no proposal transaction hash.");
      const pending = await context.client.readPendingRecovery();
      assertPendingRecoveryMatchesPrepared(pending, context.prepared);
      if (pending.readyAt <= 0n || pending.expiresAt <= pending.readyAt) throw new Error("The proposal transaction did not create a valid on-chain recovery window.");
      const updated = transitionRecoverySession(session, { type: "proposal-confirmed", transactionHash, readyAt: pending.readyAt, expiresAt: pending.expiresAt });
      await repository.write(updated);
      await onChanged();
      setMessage(`Recovery proposed on chain: ${transactionHash}`);
    } catch (error) { setMessage(safeRecoveryMessage(error)); }
    finally { setBusy(false); }
  };

  /**
   * Post this recovery to the board so guardians find it themselves.
   *
   * Without it, every guardian has to be sent the request as well as their
   * invitation -- two things, to each person, over channels the recovering
   * person has to arrange. Announced, a guardian who holds a capability sees
   * it in their own wallet and needs nothing from anyone.
   *
   * The post is unverified by construction and occupies nothing: it writes no
   * storage, cannot start a delay, and grants no authority. What it does cost
   * is disclosure -- the account, the new validator and the rotated root become
   * public now rather than when the recovery is proposed.
   */
  const announce = async () => {
    if (!session.local?.oldValidators) { setAnnounceMessage("This recovery request was created before the wallet stored the validator set, so it cannot be announced. Create a fresh request and it will carry what the board needs."); return; }
    setBusy(true); setAnnounceMessage("");
    try {
      const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
      if (!provider) throw new Error("No browser wallet is available to send the announcement. Announcing costs one transaction, so it needs a wallet that can pay for it — or hand the request to your guardians instead.");
      const deployment = await loadWalletDeployment();
      await runtime.verify(config, deployment);
      if (!deployment.recoveryIntentBoard) { setAnnounceMessage("This deployment publishes no recovery board, so guardians cannot discover the request. Hand it to them instead."); return; }
      const call = announcementCall(session, deployment.recoveryIntentBoard);
      const hash = await sendEip1193Transaction({
        provider,
        chainId: session.request.chainId,
        to: call.to,
        data: call.data
      });
      assertSuccessfulTransactionReceipt(await publicClients.forEndpoint(config.rpcUrl).waitForTransactionReceipt({ hash }));
      setAnnounced(hash);
      setAnnounceMessage("Announced. Guardians who hold an invitation for this account will now see this request in their own wallet.");
    } catch (error) { setAnnounceMessage(announceFailure(error)); }
    finally { setBusy(false); }
  };

  /** Announce, paying from one of this device's own Loom wallets. */
  const announceWithLoomWallet = async () => {
    if (!session.local?.oldValidators) { setAnnounceMessage("This request predates stored validator sets, so it cannot be announced."); return; }
    if (!announcePayer) { setAnnounceMessage("Choose a saved Loom wallet to pay for the announcement."); return; }
    setBusy(true); setAnnounceMessage("");
    try {
      const deployment = await loadWalletDeployment();
      await runtime.verify(config, deployment);
      if (!deployment.recoveryIntentBoard) { setAnnounceMessage("This deployment publishes no recovery board."); return; }
      const call = announcementCall(session, deployment.recoveryIntentBoard);
      const result = await submitAccountCalls({
        config,
        account: announcePayer,
        deployment,
        calls: [{ target: call.to, data: call.data, value: 0n }],
        pendingOperations,
        runtime,
        publicClients
      });
      setAnnounced((result.transactionHash ?? result.userOpHash) as Hex);
      setAnnounceMessage(`Announced by ${announcePayer.label}. Guardians who hold an invitation for this account will now see this request in their own wallet.`);
    } catch (error) { setAnnounceMessage(announceFailure(error)); }
    finally { setBusy(false); }
  };

  /**
   * The announcement as a transaction anyone can send.
   *
   * The same escape the publication step already offers: a reader with no
   * browser wallet, or one who would rather not connect it, can send this from
   * anywhere. Announcing grants no authority, so who sends it does not matter.
   */
  const copyAnnouncement = async () => {
    if (!session.local?.oldValidators) { setAnnounceMessage("This request predates stored validator sets, so its announcement cannot be built."); return; }
    try {
      const deployment = await loadWalletDeployment();
      if (!deployment.recoveryIntentBoard) { setAnnounceMessage("This deployment publishes no recovery board."); return; }
      const call = announcementCall(session, deployment.recoveryIntentBoard);
      await navigator.clipboard.writeText(JSON.stringify({
        chainId: session.request.chainId,
        to: call.to,
        value: "0x0",
        data: call.data
      }, null, 2));
      setAnnounceMessage("Exact announcement transaction copied. Send it from any wallet on this chain; it grants no authority to whoever does.");
    } catch { setAnnounceMessage("The browser would not copy it."); }
  };

  /** Read what guardians published on chain for this exact recovery. */
  const collectFromChain = async () => {
    setBusy(true); setBoardMessage("");
    try {
      const deployment = await loadWalletDeployment();
      await runtime.verify(config, deployment);
      if (!deployment.recoveryIntentBoard) {
        setBoardMessage("This deployment publishes no recovery board, so approvals can only arrive privately.");
        return;
      }
      const scan = await readBoardApprovals({
        chainId: session.request.chainId,
        account: session.request.account,
        board: deployment.recoveryIntentBoard,
        recoveryManager: session.request.recoveryManager,
        recoveryId: session.request.requestId,
        logTransport: publicClients.forEndpoint(config.rpcUrl) as never
      });
      setPublished(scan.approvals);
      setBoardMessage(scan.unavailable
        ? `The board could not be read: ${scan.unavailable} Private responses are unaffected.`
        : scan.approvals.length === 0
          ? "No guardian has published an approval for this recovery yet."
          : `${scan.approvals.length} approval(s) published on chain for this recovery.`);
    } catch (error) { setBoardMessage(safeRecoveryMessage(error)); }
    finally { setBusy(false); }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([serializeRecoveryProtocol(session.request)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `loom-recovery-${session.request.humanCode}.json`; link.click(); URL.revokeObjectURL(url);
  };
  const copyRequest = async () => {
    try { await navigator.clipboard.writeText(serializeRecoveryProtocol(session.request)); setMessage("Recovery request copied."); }
    catch { setMessage("Clipboard access is unavailable. Export the request file instead."); }
  };
  const showShareQr = async () => {
    try {
      const delivered = await createEncryptedLinkTransport<RecoveryRequestV1>({ origin: window.location.origin }).deliver(session.request);
      setShareLink(delivered.value);
      setMessage("The QR carries its own decryption key. Anyone who scans it can read the request, so show it only to the guardian it is meant for.");
    } catch { setMessage("A shareable link could not be produced. Export the request file instead."); }
  };
  const copyEncryptedLink = async () => {
    try {
      const delivered = await createEncryptedLinkTransport<RecoveryRequestV1>({ origin: window.location.origin }).deliver(session.request);
      await navigator.clipboard.writeText(delivered.value); setMessage("Recovery bearer link copied. It carries its own decryption key, so anyone with the link can read the request.");
    } catch { setMessage("Recovery link could not be copied. Export the request file instead."); }
  };

  /**
   * Let the local record catch up with the chain before anything is offered.
   *
   * A session proposed from another device -- or from this one, before a
   * reload -- still reads "ready to send", so the page kept offering to send
   * the request, invite guardians and announce, for a recovery the manager had
   * already accepted. Patching each of those displays would leave the record
   * itself wrong; this fixes the record, and they follow.
   */
  const reconcileWithChain = async () => {
    if (!session.local?.oldValidators) return;
    try {
      const context = await restorePending();
      const pending = await context.client.readPendingRecovery();
      if (!pending.pending) return;
      assertPendingRecoveryMatchesPrepared(pending, context.prepared);
      await repository.write(transitionRecoverySession(session, {
        type: "proposal-confirmed",
        transactionHash: session.transactionHash ?? `0x${"00".repeat(32)}`,
        readyAt: pending.readyAt,
        expiresAt: pending.expiresAt
      }));
      await onChanged();
    } catch { /* The chain is the authority, but being unable to read it changes nothing. */ }
  };

  useEffect(() => {
    if (session.stage === "request-created" || session.stage === "collecting" || session.stage === "ready-to-propose") {
      void reconcileWithChain();
    }
    if (session.stage === "delay-active") void checkPending();
  }, [session.id, session.stage]);

  // Approvals arrive two ways and the proposal already accepts both, but the
  // step that reveals the proposal counted only the ones pasted in. A recovery
  // whose guardians all published was therefore complete and looked stuck.
  const filled = new Set([
    ...session.responses.map(response => response.guardianLeaf.toLowerCase()),
    ...published.map(entry => entry.guardianLeaf.toLowerCase())
  ]).size;
  // Which panels this stage shows, and what it is asking for, decided in one
  // tested place rather than re-derived inline. See `recoverySessionView`.
  const view = recoverySessionView({
    stage: session.stage,
    seatsFilled: filled,
    threshold: session.request.guardianThreshold,
    hasProposalTransaction: Boolean(session.transactionHash),
    hasExecutionTransaction: Boolean(session.executionTransactionHash)
  });
  const seatsFilled = view.seatsFilled;
  return <main className="wallet-landing lock-layout"><section className="landing-panel"><div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div><p className="eyebrow">Recovery session · {session.request.humanCode}</p><h1>{shortStage(session.stage)}</h1><p className="breakable">{session.request.account} · Chain {session.request.chainId}</p><div className="permission-grid"><div><span>Approvals</span><strong>{seatsFilled} of {session.request.guardianThreshold}</strong></div><div><span>Config version</span><strong>{session.request.configVersion}</strong></div><div><span>Created</span><strong>{new Date(session.createdAt).toLocaleString()}</strong></div><div><span>Expires</span><strong>{new Date(session.request.expiresAt * 1000).toLocaleString()}</strong></div></div><p className="callout">Compare the six-digit code with each guardian over a channel you trust. Responses are checked against live verifier bytecode, the active guardian root, and the exact digest.</p>{message && <p className="callout" role="status">{message}</p>}{view.panels.includes("collect-from-chain") && <CollectedFromChain busy={busy} collectFromChain={collectFromChain} boardMessage={boardMessage} published={published} />}{view.panels.includes("import-response") && <ImportResponse responseArtifact={responseArtifact} setResponseArtifact={setResponseArtifact} busy={busy} importResponse={importResponse} />}{view.panels.includes("threshold-reached") && <PaidStep
        title={"Guardian threshold reached."}
        busy={busy}
        busyLabel={"Revalidating approvals…"}
        primaryLabel={"Propose & pay with Loom wallet"}
        onPrimary={() => void proposeWithLoomWallet()}
        onSecondary={() => void propose()}
        canPay={announcePayers.length > 0 && Boolean(announcePayer)}
        noPayerNote={"No other saved wallet on this chain can pay, so this needs an external wallet. The wallet being recovered cannot propose its own recovery."}
      >The browser wallet only publishes the permissionless proposal and pays gas. It receives no recovery authority.</PaidStep>}{view.panels.includes("proposal-receipt") && <ProposalReceipt session={session} />}{view.panels.includes("check-readiness") && <button className="secondary" disabled={busy} onClick={() => void checkPending()}>{busy ? "Reading chain state…" : "Check on-chain readiness"}</button>}{view.panels.includes("executable") && <PaidStep
        title={"Recovery is executable."}
        busy={busy}
        busyLabel={"Verifying pending recovery…"}
        primaryLabel={"Execute & pay with Loom wallet"}
        onPrimary={() => void executeWithLoomWallet()}
        onSecondary={() => void execute()}
        canPay={announcePayers.length > 0 && Boolean(announcePayer)}
        noPayerNote={"No other saved wallet on this chain can pay. Execution needs no passkey and no session, so any wallet with gas can finish this — including one that is not yours."}
      >The contract-enforced delay has elapsed. Execution will atomically replace the validator set and rotate the guardian root.</PaidStep>}{view.panels.includes("execution-receipt") && <ExecutionReceipt session={session} busy={busy} saveRecoveredWallet={saveRecoveredWallet} setMessage={setMessage} />}{view.panels.includes("send-to-guardians") && <SendToGuardians session={session} busy={busy} announced={announced} announceMessage={announceMessage} announcePayers={announcePayers} announcePayer={announcePayer} setAnnouncePayerId={setAnnouncePayerId} announceWithLoomWallet={announceWithLoomWallet} announce={announce} copyAnnouncement={copyAnnouncement} copyRequest={copyRequest} copyEncryptedLink={copyEncryptedLink} showShareQr={showShareQr} download={download} shareLink={shareLink} shortAddress={shortAddress} />}<div className="guardian-actions"><button className="secondary" onClick={onBack}>All sessions</button></div></section></main>;
}

/**
 * The announcement, built once for the three places that send it.
 *
 * The external wallet path, the Loom wallet path, and the copied transaction
 * each encoded it separately, so a correction reached one of three. They must
 * be the same bytes: a person who copies the transaction and compares it with
 * what the wallet would have sent should find no difference.
 */
function announcementCall(session: RecoverySession, board: `0x${string}`) {
  return announceRecovery({
    board,
    account: session.request.account,
    recoveryManager: session.request.recoveryManager,
    oldValidatorsHash: oldValidatorsHash([...(session.local?.oldValidators ?? [])]),
    newValidator: session.request.newValidator,
    initDataHash: session.request.initDataHash,
    newGuardianRoot: session.request.newGuardianRoot,
    newGuardianThreshold: session.request.newGuardianThreshold,
    expiresAt: session.request.expiresAt
  });
}
