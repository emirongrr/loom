import { useEffect, useMemo, useState } from "react";
import { GuardianRecoveryError, createRecoveryRequest, parseRecoveryRequest, parseRecoveryResponse, serializeRecoveryProtocol, type GuardianApprovalTuple, type RecoveryRequestV1 } from "@loom/sdk/recovery";
import { RecoveryManagerAbi } from "@loom/core/abi";
import { getAddress, isAddress, type Hex } from "viem";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { loadWalletDeployment, registerBrowserPasskey } from "../onboarding/accountLifecycle";
import { createAccountGuardianClient } from "../security/guardianClient";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import {
  createRecoverySession, createRecoverySessionRepository, transitionRecoverySession, type RecoverySession, type RecoverySessionIssue, type RecoverySessionRepository
} from "./recoverySession";
import { recoverySessionView } from "./recoverySessionView";
import { announceRecovery, oldValidatorsHash } from "./recoveryCalls";
import { CollectedFromChain, ExecutionReceipt, ImportResponse, PaidStep, ProposalReceipt, SendToGuardians } from "./RecoverySessionPanels";
import {
  prepareNewRecoveryPasskey, publishRecoveryValidator, sendEip1193Transaction, type Eip1193Provider
} from "./recoveryPasskey";
import { createBrowserGuardianRoster } from "../../storage/guardianRoster";
import { planGuardianChange, withFreshSalts } from "../security/guardianPlan";
import { rosterMatchesRoot } from "../security/guardianStatus";
import { assertPendingRecoveryMatchesPrepared, assertPreparedRecoveryMatchesRequest, assertSuccessfulTransactionReceipt, restorePreparedRecovery, verifyRecoveryResponseForProposal } from "./recoveryProposal";
import type { AccountHandle } from "../../types";
import { publishRecoveryValidatorWithLoomWallet, recoveryGasPayers, selectRecoveryGasPayer } from "./recoveryGasPayer";
import { submitAccountCalls } from "../wallet/accountClient";
import { createRecoveryDraft, createRecoveryDraftRepository, restoreRecoveryDraftPreparation, type RecoveryDraftRotation } from "./recoveryDraft";
import { describeDraftFailure, summarizeDraftFailures, type DraftFailure } from "./draftDiagnosis";
import { mergeApprovals, readBoardApprovals, type BoardApproval } from "./boardApprovals";
import { classifyExistingPublications, readPublishedRecoveryValidators, type ExistingPublications, type PublishedRecoveryValidator } from "./existingPublications";
import { collectAccountRecoveryRequests, type AccountRecoveryRequest, type OnChainPendingRecovery } from "./accountRecoveryRequests";
import { AccountRecoveryRequestsPanel } from "./AccountRecoveryRequestsPanel";
import { RecoveryLookupPanel } from "./RecoveryLookupPanel";
import { RecoveryStepper, recoveryViewStage } from "./RecoveryStepper";
import { GasPayerChoice } from "./GasPayerChoice";
import { useRecoverySetupController } from "./useRecoverySetupController";
import { shortAddress } from "../../components/address.ts";

export function RecoveryPage({ path, accounts, preferredGasPayerId, sourceWalletOpen = false, onClose, onNavigate, onRecovered }: {
  readonly path: string;
  readonly accounts: readonly AccountHandle[];
  readonly preferredGasPayerId?: string;
  readonly sourceWalletOpen?: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
  readonly onRecovered: (handle: AccountHandle) => Promise<void>;
}) {
  const { config } = useNetwork();
  const { publicClients, runtime, pendingOperations } = useAppServices();
  const repository = useMemo(() => createRecoverySessionRepository(), []);
  const draftRepository = useMemo(() => createRecoveryDraftRepository(), []);
  const recoveryLinks = useMemo(() => createEncryptedLinkTransport<RecoveryRequestV1>({ origin: window.location.origin }), []);
  const [account, setAccount] = useState("");
  const { inspection, setInspection, showPasskey, setShowPasskey, passkeyStatus, setPasskeyStatus, passkeyPreparation, setPasskeyPreparation } = useRecoverySetupController();
  const [artifact, setArtifact] = useState("");
  /** The session being removed, held while its confirmation is on screen. */
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly RecoverySession[]>([]);
  const [issues, setIssues] = useState<readonly RecoverySessionIssue[]>([]);
  const [message, setMessage] = useState("");
  const [passkeyLabel, setPasskeyLabel] = useState("Recovered wallet");
  const [publications, setPublications] = useState<ExistingPublications>({ kind: "none" });
  // What the chain and this device already hold for the account under
  // inspection, gathered on the same pass that checks it.
  const [onChainPublished, setOnChainPublished] = useState<readonly PublishedRecoveryValidator[]>([]);
  const [onChainPending, setOnChainPending] = useState<OnChainPendingRecovery | null>(null);
  const [unreadableDrafts, setUnreadableDrafts] = useState(0);
  const [draftFailures, setDraftFailures] = useState<readonly DraftFailure[]>([]);
  // The rotation the published validator commits to. Chosen once, before
  // publication, and reused for the proposal: choosing again would produce a
  // different root, a different digest, and a validator nobody could propose.
  const [rotation, setRotation] = useState<RecoveryDraftRotation | null>(null);
  const [restoredDrafts, setRestoredDrafts] = useState<readonly { readonly validator: `0x${string}`; readonly published: boolean }[]>([]);
  const [gasPayerId, setGasPayerId] = useState("");
  const selectedId = sessionIdFromPath(path);
  const selected = path.startsWith("/recover/") ? sessions.find(session => session.id === selectedId) : undefined;
  const gasPayers = inspection.status === "protected"
    ? recoveryGasPayers(accounts, inspection.deployment.chainId, inspection.account)
    : [];
  const preferredGasPayer = accounts.find(candidate => candidate.id === preferredGasPayerId);
  const selectedGasPayer = selectRecoveryGasPayer(gasPayers, gasPayerId || preferredGasPayerId);

  // Gathered rather than fetched again: everything below already came back
  // with the account check, so the panel cannot disagree with the page.
  const accountRequests: readonly AccountRecoveryRequest[] = inspection.status === "protected"
    ? collectAccountRecoveryRequests({
      chainId: inspection.deployment.chainId,
      account: inspection.account,
      sessions,
      published: onChainPublished,
      unreadableDrafts,
      restored: restoredDrafts.length > 0
        ? restoredDrafts
        : passkeyPreparation
          ? [{ validator: passkeyPreparation.validator, published: passkeyPreparation.alreadyDeployed }]
          : [],
      ...(onChainPending ? { pending: onChainPending } : {})
    })
    : [];

  // Once an account is named, the page is about that account. Its own requests
  // are listed beside it with their duplicates marked, and records belonging to
  // other accounts are not merely redundant here -- shown next to a wallet they
  // have nothing to do with, they read as that wallet's history. So this list
  // only exists before an account is chosen, when resuming from a cold start is
  // the whole point.
  const showAllSessions = inspection.status !== "protected";

  const refresh = async () => {
    const snapshot = await repository.inspect();
    setSessions(snapshot.sessions);
    setIssues(snapshot.issues);
  };
  useEffect(() => { void refresh().catch(() => setMessage("Encrypted recovery sessions could not be read.")); }, []);

  const inspect = async () => {
    setMessage("");
    if (!isAddress(account)) { setMessage("Enter a valid account address."); return; }
    setInspection({ status: "loading" });
    try {
      const deployment = await loadWalletDeployment();
      await runtime.verify(config, deployment);
      if (!deployment.recoveryModule) throw new GuardianRecoveryError("RECOVERY_NOT_CONFIGURED", "deployment has no recovery manager");
      const client = createAccountGuardianClient({
        config,
        chainId: deployment.chainId,
        account: getAddress(account),
        recoveryManager: deployment.recoveryModule,
        publicClients,
        recoveryValidatorProvisioner: deployment.recoveryValidatorProvisioner,
        policyHook: deployment.policyHook
      });
      const state = await client.inspectAccount();
      if (!state.recoveryConfigured) throw new GuardianRecoveryError("RECOVERY_NOT_CONFIGURED", "account has no active guardian recovery");
      setInspection({ status: "protected", account: getAddress(account), threshold: state.guardianThreshold, configVersion: state.configVersion.toString(), validators: state.validators.length, deployment });
      // Nothing is chosen between checking the account and creating the
      // passkey, so this advances rather than asking for a click that
      // decides nothing. The provisioning notice moves with it.
      if (deployment.recoveryValidatorProvisioner) setShowPasskey(true);
      setPublications({ kind: "none" });
      setOnChainPublished([]);
      setOnChainPending(null);
      setUnreadableDrafts(0);
      setDraftFailures([]);
      setRestoredDrafts([]);
      setRotation(null);
      try {
        // A proposal already approved by guardians needs no session here, but a
        // reader who cannot see it has no way to know that.
        const chainPending = await client.readPendingRecovery();
        setOnChainPending({
          pending: chainPending.pending, newValidator: chainPending.newValidator,
          status: pendingStatus(chainPending.status),
          readyAt: chainPending.readyAt, expiresAt: chainPending.expiresAt
        });
      } catch { /* The pending record is additional context, not a precondition. */ }
      const drafts = (await draftRepository.inspect()).drafts.filter(draft =>
        draft.chainId === deployment.chainId
        && draft.account.toLowerCase() === account.toLowerCase()
        && draft.configVersion === state.configVersion.toString()
      );
      // Every draft is tried, not just the first that opens. Stopping at the
      // first left a second held draft untried, and its publication was then
      // reported as belonging to some other device.
      const restored: { validator: `0x${string}`; published: boolean }[] = [];
      // A draft that fails to open is not the same as no draft at all, and the
      // difference decides whether the reader should hunt for their passkey or
      // pay to publish a new one.
      let unreadable = 0;
      const failures: DraftFailure[] = [];
      for (const draft of drafts) {
        // Each stage is separated so a failure says how far the draft got.
        // Collapsed into one try, "could not be opened" covered a corrupt
        // record, an RPC that would not answer, and a draft that simply named
        // a different validator -- three different problems with three
        // different answers.
        let local: ReturnType<typeof restoreRecoveryDraftPreparation>;
        try {
          local = restoreRecoveryDraftPreparation(draft);
        } catch (error) {
          unreadable += 1;
          failures.push(describeDraftFailure({ stage: "decode", label: draft.label, error }));
          continue;
        }
        try {
          const checked = await client.prepareRecoveryValidator({
            initData: local.initData,
            newGuardianSet: rotationSet(draft.rotation)
          });
          if (checked.validator !== local.validator || checked.initDataHash !== local.initDataHash) {
            unreadable += 1;
            failures.push(describeDraftFailure({ stage: "mismatch", label: draft.label }));
            continue;
          }
          restored.push({ validator: checked.validator, published: checked.alreadyDeployed });
          // The passkey step can only carry one, so it keeps the first that
          // opened; the rest are still reported, because the reader paid for
          // them and only one of them can ever be proposed.
          if (restored.length === 1) {
            setPasskeyLabel(draft.label);
            setPasskeyPreparation(Object.freeze({ ...local, ...checked }));
            setRotation(draft.rotation);
            setShowPasskey(true);
            setPasskeyStatus(checked.alreadyDeployed ? "published" : "prepared");
            setMessage(checked.alreadyDeployed ? "Your encrypted recovery draft matched the live validator deployment. Continue with guardian approvals." : "Your encrypted recovery passkey draft was restored. Publish its exact validator call to continue.");
          }
        } catch (error) {
          // A stale draft cannot hide another healthy draft or the live account
          // state, but it is still reported: silence here is what told a user
          // holding drafts that this device held nothing.
          unreadable += 1;
          failures.push(describeDraftFailure({ stage: "derive", label: draft.label, error }));
        }
      }
      setDraftFailures(failures);
      setRestoredDrafts(restored);

      // Publishing costs gas and only one recovery can be proposed per nonce, so
      // an earlier publication this device cannot continue has to be said out
      // loud rather than left for the user to discover on an explorer.
      const provisioner = deployment.recoveryValidatorProvisioner;
      if (provisioner && deployment.recoveryModule) {
        const publicClient = publicClients.forEndpoint(config.rpcUrl);
        const recoveryNonce = await publicClient.readContract({
          address: deployment.recoveryModule, abi: RecoveryManagerAbi, functionName: "recoveryNonces",
          args: [getAddress(account)]
        }) as bigint;
        const scan = await readPublishedRecoveryValidators({
          publicClient,
          verificationClient: publicClients.forEndpoint(config.verificationRpcUrl),
          factory: provisioner.address, account: getAddress(account), recoveryNonce
        });
        setUnreadableDrafts(unreadable);
        setOnChainPublished(scan.published);
        setPublications(classifyExistingPublications({
          published: scan.published,
          complete: scan.complete,
          consistent: scan.consistent,
          scannedFromBlock: scan.scannedFromBlock,
          heldDrafts: unreadable,
          ...(restored[0] ? { restored: restored[0].validator } : {})
        }));
      }
    } catch (error) {
      setInspection({ status: "blocked", message: safeRecoveryMessage(error) });
    }
  };

  const recoveryClient = () => {
    if (inspection.status !== "protected" || !inspection.deployment.recoveryModule) {
      throw new Error("Check the account recovery state again.");
    }
    return createAccountGuardianClient({
      config,
      chainId: inspection.deployment.chainId,
      account: inspection.account,
      recoveryManager: inspection.deployment.recoveryModule,
      publicClients,
      recoveryValidatorProvisioner: inspection.deployment.recoveryValidatorProvisioner,
      policyHook: inspection.deployment.policyHook
    });
  };

  const createPasskey = async () => {
    if (inspection.status !== "protected") return;
    setMessage(""); setPasskeyStatus("creating");
    try {
      const client = recoveryClient();
      const live = await client.inspectAccount();
      if (!live.recoveryConfigured || live.configVersion.toString() !== inspection.configVersion) {
        throw new GuardianRecoveryError("RECOVERY_CONFIG_VERSION_MISMATCH", "account recovery state changed; check it again");
      }
      // The rotation has to exist before the address does, because the address
      // commits to it. It also has to come from a roster that matches the live
      // root, or the guardians being rotated away from could not approve.
      const accountId = `${inspection.deployment.chainId}:${inspection.account.toLowerCase()}`;
      const roster = await createBrowserGuardianRoster().read(accountId);
      if (!rosterMatchesRoot({ entries: roster.entries, threshold: live.guardianThreshold, root: live.guardianRoot })) {
        throw new Error("This device does not hold the current guardian roster, so it cannot choose the set this recovery rotates to. Restore its encrypted guardian backup first.");
      }
      const chosen: RecoveryDraftRotation = Object.freeze({
        entries: withFreshSalts(roster.entries),
        threshold: live.guardianThreshold
      });
      const prepared = await prepareNewRecoveryPasskey({
        deployment: inspection.deployment,
        label: passkeyLabel,
        rpId: window.location.hostname,
        origin: window.location.origin,
        register: registerBrowserPasskey,
        prepare: input => client.prepareRecoveryValidator({ ...input, newGuardianSet: rotationSet(chosen) })
      });
      await draftRepository.write(createRecoveryDraft({
        chainId: inspection.deployment.chainId,
        account: inspection.account,
        configVersion: inspection.configVersion,
        label: passkeyLabel.trim(),
        preparation: prepared,
        rotation: chosen
      }));
      setRotation(chosen);
      setPasskeyPreparation(prepared);
      setPasskeyStatus(prepared.alreadyDeployed ? "published" : "prepared");
    } catch (error) {
      setPasskeyStatus("idle");
      setMessage(safeRecoveryMessage(error));
    }
  };

  const verifyPublication = async () => {
    if (!passkeyPreparation || !rotation) return;
    const checked = await recoveryClient().prepareRecoveryValidator({
      initData: passkeyPreparation.initData,
      newGuardianSet: rotationSet(rotation)
    });
    if (!checked.alreadyDeployed || checked.validator !== passkeyPreparation.validator) {
      throw new Error("The exact recovery validator is not published on chain yet.");
    }
    setPasskeyPreparation(Object.freeze({ ...passkeyPreparation, alreadyDeployed: true }));
    setPasskeyStatus("published");
  };

  const publish = async () => {
    if (inspection.status !== "protected" || !passkeyPreparation?.deploy) return;
    setMessage(""); setPasskeyStatus("publishing");
    try {
      const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
      if (!provider) throw new Error("No browser wallet is available. Copy the exact transaction and publish it from any Sepolia wallet.");
      const hash = await publishRecoveryValidator({ provider, chainId: inspection.deployment.chainId, deploy: passkeyPreparation.deploy });
      assertSuccessfulTransactionReceipt(await publicClients.forEndpoint(config.rpcUrl).waitForTransactionReceipt({ hash }));
      await verifyPublication();
      setMessage(`Recovery validator published: ${hash}`);
    } catch (error) {
      setPasskeyStatus("prepared");
      setMessage(safeRecoveryMessage(error));
    }
  };

  const publishWithLoomWallet = async () => {
    if (inspection.status !== "protected" || !passkeyPreparation?.deploy || !selectedGasPayer) return;
    setMessage(""); setPasskeyStatus("publishing");
    try {
      const publicClient = publicClients.forEndpoint(config.rpcUrl);
      const result = await publishRecoveryValidatorWithLoomWallet({
        config,
        payer: selectedGasPayer,
        recoveryAccount: inspection.account,
        deployment: inspection.deployment,
        deploy: passkeyPreparation.deploy,
        initDataHash: passkeyPreparation.initDataHash,
        readCode: address => publicClient.getCode({ address }),
        submit: submitInput => submitAccountCalls({ ...submitInput, pendingOperations, runtime, publicClients })
      });
      await verifyPublication();
      setMessage(`Recovery validator published by ${selectedGasPayer.label}: ${result.transactionHash ?? result.userOpHash}`);
    } catch (error) {
      setPasskeyStatus("prepared");
      setMessage(safeRecoveryMessage(error));
    }
  };

  const copyPublication = async () => {
    if (!passkeyPreparation?.deploy) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        chainId: inspection.status === "protected" ? inspection.deployment.chainId : undefined,
        to: passkeyPreparation.deploy.to,
        data: passkeyPreparation.deploy.data,
        value: "0x0"
      }, null, 2));
      setMessage("Exact permissionless publication transaction copied.");
    } catch { setMessage("Clipboard access is unavailable."); }
  };

  const prepareGuardianRequest = async () => {
    if (inspection.status !== "protected" || !inspection.deployment.recoveryModule || !passkeyPreparation?.alreadyDeployed) return;
    setMessage("");

    // A second request for the same validator is not a second chance, it is a
    // different request: each one rotates to a fresh guardian set, so its
    // digest differs and any approval already collected for the first no
    // longer verifies. With one pending request per nonce, only one of them
    // could ever be proposed anyway. So the existing one is opened instead.
    const openRequest = sessions.find(candidate =>
      candidate.request.chainId === inspection.deployment.chainId
      && candidate.request.account.toLowerCase() === inspection.account.toLowerCase()
      && candidate.request.newValidator.toLowerCase() === passkeyPreparation.validator.toLowerCase()
      && !["completed", "cancelled", "expired"].includes(candidate.stage)
    );
    if (openRequest) {
      setMessage("A recovery request for this validator is already open on this device. Continue with that one: a second request would rotate to a different guardian set, and approvals collected for the first would stop verifying.");
      onNavigate(`/recover/${encodeURIComponent(openRequest.id)}`);
      return;
    }

    try {
      const client = recoveryClient();
      const live = await client.inspectAccount();
      if (!live.recoveryConfigured || live.configVersion.toString() !== inspection.configVersion) {
        throw new Error("Account recovery state changed. Check the account again before requesting approvals.");
      }
      const accountId = `${inspection.deployment.chainId}:${inspection.account.toLowerCase()}`;
      const roster = await createBrowserGuardianRoster().read(accountId);
      if (!rosterMatchesRoot({ entries: roster.entries, threshold: live.guardianThreshold, root: live.guardianRoot })) {
        throw new Error("This device does not hold the current guardian roster. Restore its encrypted guardian backup before creating a recovery request.");
      }
      // The rotation was fixed when the validator was published: its address
      // commits to it. Choosing fresh salts again here would produce a
      // different root, a digest the guardians would sign against nothing, and
      // a proposal naming a validator that does not exist.
      if (!rotation) throw new Error("This device does not hold the rotation this publication committed to. Restore the recovery draft, or publish a new recovery passkey.");
      const freshGuardianEntries = rotation.entries;
      const newGuardianSet = planGuardianChange({ current: roster.entries, next: freshGuardianEntries, threshold: rotation.threshold }).set;
      const prepared = await client.prepareRecovery({
        newValidator: passkeyPreparation.validator,
        initData: passkeyPreparation.initData,
        newGuardianSet
      });
      const createdAt = Math.floor(Date.now() / 1000);
      const request = createRecoveryRequest({
        requestId: prepared.recoveryId,
        chainId: inspection.deployment.chainId,
        account: inspection.account,
        recoveryManager: inspection.deployment.recoveryModule,
        guardianRoot: live.guardianRoot,
        guardianThreshold: live.guardianThreshold,
        configVersion: live.configVersion.toString(),
        nonce: prepared.nonce.toString(),
        newValidator: prepared.newValidator,
        initDataHash: prepared.initDataHash,
        newGuardianRoot: prepared.newGuardianSet.root,
        newGuardianThreshold: prepared.newGuardianSet.threshold,
        createdAt,
        expiresAt: createdAt + 604_800
      });
      const session = createRecoverySession(request, Date.now(), {
        initData: passkeyPreparation.initData,
        credentialId: passkeyPreparation.passkey.credentialId,
        publicKey: passkeyPreparation.passkey.publicKey,
        rpId: passkeyPreparation.rpId,
        origin: passkeyPreparation.origin,
        freshGuardianEntries,
        oldValidators: prepared.oldValidators
      });
      await repository.write(session);
      await draftRepository.remove(`${inspection.deployment.chainId}:${inspection.account.toLowerCase()}:${passkeyPreparation.validator.toLowerCase()}`);
      await refresh();
      onNavigate(`/recover/${encodeURIComponent(session.id)}`);
    } catch (error) { setMessage(safeRecoveryMessage(error)); }
  };

  const importRequest = async () => {
    setMessage("");
    try {
      const request = artifact.trim().startsWith("{")
        ? parseRecoveryRequest(artifact)
        : parseRecoveryRequest(await recoveryLinks.receive(artifact));
      const session = createRecoverySession(request);
      await repository.write(session);
      await refresh();
      setArtifact("");
      onNavigate(`/recover/${encodeURIComponent(session.id)}`);
    } catch (error) { setMessage(safeRecoveryMessage(error)); }
  };

  if (selected) return <RecoveryProposalSessionView session={selected} repository={repository} accounts={accounts} onChanged={refresh} onRecovered={onRecovered} onBack={() => onNavigate("/recover")} />;

  return <main className="wallet-landing recovery-layout">
    <section className="landing-panel" aria-labelledby="recovery-title">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p className="eyebrow">Self-sovereign recovery</p>
      <h1 id="recovery-title">Recover account control</h1>
      <p>Recovery replaces account validators only after the existing guardian threshold approves, the on-chain delay completes, and the exact reviewed request still matches live state.</p>
      {preferredGasPayer && <div className="callout success"><strong>{sourceWalletOpen ? `${preferredGasPayer.label} remains open.` : `${preferredGasPayer.label} is selected as gas payer.`}</strong><p>You entered recovery from {shortAddress(preferredGasPayer.account)}. It is preselected to pay the factory gas when the recovery target is a different account, and its passkey will be requested only when publishing.</p></div>}
      <RecoveryStepper stage={recoveryViewStage({
        showingPasskey: showPasskey,
        validatorPublished: onChainPublished.length > 0 || restoredDrafts.some(entry => entry.published),
        pendingOnChain: onChainPending?.pending === true
      })} />
      {!showPasskey && <><label className="field"><span>Account to recover</span><input value={account} onChange={event => { setAccount(event.target.value); setInspection({ status: "idle" }); setPasskeyPreparation(null); }} placeholder="0x…" spellCheck={false} /></label>
      <div className="landing-actions"><button className="secondary" onClick={onClose}>{preferredGasPayer && sourceWalletOpen ? `Return to ${preferredGasPayer.label}` : "Back to wallets"}</button><button className="primary" disabled={inspection.status === "loading"} onClick={() => void inspect()}>{inspection.status === "loading" ? "Checking live state…" : "Check recovery"}</button></div></>}
      {inspection.status === "protected" && <div className="callout success"><strong>Guardian recovery is active.</strong><p>{inspection.threshold} approvals required · config version {inspection.configVersion} · {inspection.validators} validator(s)</p></div>}
      {inspection.status === "protected" && preferredGasPayer?.chainId === inspection.deployment.chainId && preferredGasPayer.account.toLowerCase() === inspection.account.toLowerCase() && <div className="callout warning"><strong>This wallet is the recovery target.</strong><p>It cannot pay its own recovery factory gas while its old passkey is unavailable. Choose another Saved Wallet in the publication step.</p></div>}
      {inspection.status === "protected" && !inspection.deployment.recoveryValidatorProvisioner && <div className="callout warning"><strong>New validator provisioning is unavailable.</strong><p>This deployment does not publish a trusted one-time recovered-validator provisioning path. Recovery stops safely before creating a passkey, request, approval, or transaction.</p><code>UNSUPPORTED_RECOVERED_VALIDATOR_PATH</code></div>}
      {inspection.status === "protected" && inspection.deployment.recoveryValidatorProvisioner && showPasskey && <div className="callout success"><strong>Permissionless validator provisioning is verified.</strong><p>The deployment publishes the factory and child bytecode commitments required for a new recovery passkey.</p></div>}
      {inspection.status === "protected" && showPasskey && <div className="recovery-passkey-stage">
        <p className="eyebrow">Step 2 of 4</p><h2>Create a new recovery passkey</h2>
        <p>This passkey becomes authoritative only after guardian approval, the on-chain delay, and recovery execution. Your current validators remain unchanged now.</p>
        {publications.kind === "orphaned" && <p className="callout warning"><strong>A recovery passkey was already published for this account.</strong> {publications.message}</p>}
        {/* A scan that could not reach the start of the chain has found nothing
            and proved nothing. Rendering that as silence would let the reader
            believe the check ran when it only ran partway. */}
        {draftFailures.length > 0 && <p className="callout warning">
          <strong>This device holds recovery drafts it could not use.</strong> {summarizeDraftFailures(draftFailures)}
          {" "}A draft that fails here is a storage problem, not a lost passkey — publishing another validator
          would cost gas without addressing it.
        </p>}
        {publications.kind === "unknown" && <p className="callout"><strong>This check could not read the whole chain.</strong> {publications.message}</p>}
        {!passkeyPreparation && <><p className="callout warning">A validator deployment alone cannot restore its passkey metadata. If this recovery was started before encrypted drafts were supported, create one new recovery passkey; this attempt will be saved before any factory transaction and will resume after reload.</p><label className="field"><span>Passkey name</span><input value={passkeyLabel} maxLength={80} onChange={event => setPasskeyLabel(event.target.value)} /></label><div className="landing-actions"><button className="secondary" onClick={() => setShowPasskey(false)}>Back</button><button className="primary" disabled={passkeyStatus === "creating"} onClick={() => void createPasskey()}>{passkeyStatus === "creating" ? "Creating passkey…" : "Create recovery passkey"}</button></div></>}
        {passkeyPreparation && <><div className="callout"><strong>Recovery validator</strong><p className="breakable">{passkeyPreparation.validator}</p></div>
          {passkeyStatus !== "published" ? <><p className="form-note">Publishing this exact factory call is permissionless and grants no account authority. The publishing wallet only pays network gas.</p>
            {gasPayers.length > 0 && <div className="callout">
              <GasPayerChoice
                label="Pay gas with a saved Loom wallet"
                candidates={gasPayers}
                selected={selectedGasPayer}
                disabled={passkeyStatus === "publishing"}
                onSelect={setGasPayerId}
              />
              <button className="primary" disabled={passkeyStatus === "publishing" || !selectedGasPayer} onClick={() => void publishWithLoomWallet()}>{passkeyStatus === "publishing" ? "Confirm on your device…" : "Publish & pay with Loom wallet"}</button>
            </div>}
            {gasPayers.length === 0 && <p className="callout warning">No other Saved Wallet on this chain is available. Save and activate another Loom wallet, or use an external publisher.</p>}
            <div className="guardian-actions"><button className="secondary" onClick={() => void copyPublication()}>Copy exact transaction</button><button className="secondary" onClick={() => void verifyPublication().catch(error => setMessage(error instanceof Error ? error.message : "Publication could not be verified."))}>Check publication</button><button className="secondary" disabled={passkeyStatus === "publishing"} onClick={() => void publish()}>{passkeyStatus === "publishing" ? "Publishing…" : "Use external browser wallet"}</button></div></> : <><div className="callout success"><strong>New passkey validator is live.</strong><p>The exact child bytecode is verified on chain.</p></div><button className="primary" onClick={() => void prepareGuardianRequest()}>Continue to guardian approvals</button></>}
        </>}
      </div>}
      {inspection.status === "blocked" && <p className="callout warning">{inspection.message}</p>}
      {message && <p className="callout warning" role="status">{message}</p>}
    </section>

    {inspection.status === "protected" && <AccountRecoveryRequestsPanel
      requests={accountRequests}
      busy={passkeyStatus === "publishing" || passkeyStatus === "creating"}
      onOpenSession={sessionId => onNavigate(`/recover/${encodeURIComponent(sessionId)}`)}
      onRequestApprovals={() => void prepareGuardianRequest()}
      onPublish={() => { setShowPasskey(true); }}
      onDiscardSession={sessionId => void (async () => {
        await repository.remove(sessionId);
        await refresh();
        setMessage("The duplicate recovery request was removed from this device. Nothing on chain changed.");
      })().catch(() => setMessage("The duplicate request could not be removed."))}
    />}

    {/* One address drives everything. "Account to recover" already accepts any
        account, held or not, so a second address field asked the same question
        twice; and executing an approved, matured recovery needs no session and
        no passkey (ADR-0025), only the address and gas. This appears exactly
        when the chain says there is something to finish. */}
    {inspection.status === "protected" && onChainPending?.pending
      && <RecoveryLookupPanel fixedAccount={inspection.account} />}
    {showAllSessions && <section className="saved-wallets" aria-labelledby="recovery-sessions-title">
      <div className="section-heading"><div><p className="eyebrow">Encrypted on this device</p><h2 id="recovery-sessions-title">Recovery sessions</h2></div><span className="pill">{sessions.length}</span></div>
      {issues.length > 0 && <p className="callout warning">{issues.length} unreadable local record(s) were isolated. Healthy sessions remain available.</p>}
      {sessions.length === 0 ? <div className="empty-state compact"><h3>No recovery in progress</h3><p>A recovery session will remain here through approval collection, delay, execution, cancellation, or expiry.</p></div> : <div className="wallet-list">{sessions.map(session => <div key={session.id} className="wallet-list-item">
          {/* The row is the container; the button that opens it sits inside,
              as it does for saved wallets. Made the button itself, its third
              child fell to a second line and the stage ran into the address. */}
          <button className="wallet-list-open" onClick={() => onNavigate(`/recover/${encodeURIComponent(session.id)}`)}>
            <span className="identicon" aria-hidden="true" />
            <span><strong>{shortStage(session.stage)}</strong><small>{session.request.humanCode} · {shortAddress(session.request.account)}</small></span>
            <span className="pill pending">Open</span>
          </button>
          <button
            className="wallet-list-remove"
            aria-label={`Remove the ${shortStage(session.stage).toLowerCase()} session for ${shortAddress(session.request.account)}`}
            onClick={() => { setMessage(""); setDiscarding(session.id); }}
          >
            <svg className="wallet-list-remove-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M9 3h6m-9 4h12m-1 0-.6 12a2 2 0 0 1-2 2H9.6a2 2 0 0 1-2-2L7 7m3 4v6m4-6v6" /></svg>
            <span>Remove</span>
          </button>
          {/* Asked before it happens, because a session can hold guardian
              approvals that were collected but never published, and this
              device may be the only place they exist. The recovery itself is
              on chain and is untouched either way. */}
          {discarding === session.id && <div className="removal-confirmation">
            <div className="removal-warning">
              <span aria-hidden="true">!</span>
              <div>
                <strong>Remove this session from this device?</strong>
                <p>Any approvals collected here and not yet published are lost with it. Nothing on chain changes: the recovery itself, and its delay, carry on.</p>
              </div>
            </div>
            <div className="guardian-actions">
              <button className="danger-button" onClick={() => void (async () => {
                await repository.remove(session.id);
                setDiscarding(null);
                await refresh();
                setMessage("The session was removed from this device. Nothing on chain changed.");
              })().catch(() => setMessage("That session could not be removed."))}>Remove</button>
              <button className="text-button" onClick={() => setDiscarding(null)}>Keep it</button>
            </div>
          </div>}
        </div>)}</div>}
      <details><summary>Resume from a portable request</summary><p className="form-note">Paste a versioned recovery request received through a file, QR, clipboard, or bearer-link fragment. Unknown, altered, mismatched, and expired fields fail closed.</p><label className="field"><span>Recovery request</span><textarea rows={6} value={artifact} onChange={event => setArtifact(event.target.value)} placeholder='{"format":"loom.recovery-request",…}' /></label><button className="secondary" disabled={!artifact.trim()} onClick={() => void importRequest()}>Verify and save locally</button></details>
    </section>}
  </main>;
}

function RecoveryProposalSessionView({ session, repository, accounts, onChanged, onRecovered, onBack }: {
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

function shortStage(stage: RecoverySession["stage"]): string {
  return ({ "request-created": "Request ready", collecting: "Collecting approvals", "ready-to-propose": "Ready to propose", "delay-active": "Security delay active", "ready-to-execute": "Ready to execute", completed: "Recovery completed", cancelled: "Recovery cancelled", expired: "Recovery expired", blocked: "Recovery blocked" })[stage];
}

/**
 * Why an announcement did not go out, in the announcer's own terms.
 *
 * `safeRecoveryMessage` collapses everything into one sentence about the
 * account, the network and the RPC, which is right where an error might carry
 * something about the recovery itself. Nothing on this path does: every message
 * here is written either by this repository -- the deployment loader, the
 * runtime verifier -- or by the reader's own wallet telling them what it
 * refused. Collapsing those hid the one thing that would let them fix it.
 */
function announceFailure(error: unknown): string {
  if (error instanceof GuardianRecoveryError) return `${error.code}: ${error.safeMessage}`;
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  return safeRecoveryMessage(error);
}

function safeRecoveryMessage(error: unknown): string {
  if (error instanceof GuardianRecoveryError) return error.safeMessage;
  return "Recovery state could not be verified. Check the account, network, and RPC, then retry.";
}

/**
 * Narrow the manager status the SDK widened to `string`.
 *
 * An unrecognised value is reported as unknown rather than trusted through:
 * this drives what the reader is told about a recovery's timing.
 */
function pendingStatus(value: string): OnChainPendingRecovery["status"] {
  return value === "none" || value === "delay-active" || value === "ready" || value === "expired"
    ? value
    : "unknown";
}

/** The rotation as the SDK wants it: a root and a threshold. */
function rotationSet(value: RecoveryDraftRotation): { root: `0x${string}`; threshold: number } {
  const set = planGuardianChange({ current: [], next: value.entries, threshold: value.threshold }).set;
  return { root: set.root, threshold: set.threshold };
}

function sessionIdFromPath(path: string): string {
  if (!path.startsWith("/recover/")) return "";
  try { return decodeURIComponent(path.slice("/recover/".length)); }
  catch { return ""; }
}
