import { useEffect, useMemo, useState } from "react";
import { GuardianRecoveryError, createRecoveryRequest, parseRecoveryRequest, type RecoveryRequestV1 } from "@loom/sdk/recovery";
import { createRpcStateTransport } from "@loom/sdk";
import { readAccountHandle } from "@loom/sdk/account-discovery";
import { RecoveryManagerAbi } from "@loom/core/abi";
import { getAddress, isAddress } from "viem";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { assertRegisteredBrowserPasskey, loadWalletDeployment, registerBrowserPasskey } from "../onboarding/accountLifecycle";
import { createAccountGuardianClient } from "../security/guardianClient";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import { createRecoverySession, createRecoverySessionRepository, type RecoverySession, type RecoverySessionIssue } from "./recoverySession";
import { assertRecoveryPasskeyUsable, prepareNewRecoveryPasskey, publishRecoveryValidator, type Eip1193Provider } from "./recoveryPasskey";
import { planGuardianChange, withFreshSalts } from "../security/guardianPlan";
import { rosterMatchesRoot } from "../security/guardianStatus";
import { assertSuccessfulTransactionReceipt } from "./recoveryProposal";
import type { AccountHandle } from "../../types";
import { publishRecoveryValidatorWithLoomWallet, recoveryGasPayers, selectRecoveryGasPayer } from "./recoveryGasPayer";
import { submitAccountCalls } from "../wallet/accountClient";
import { createRecoveryDraft, createRecoveryDraftRepository, restoreRecoveryDraftPreparation, type RecoveryDraftRotation } from "./recoveryDraft";
import { describeDraftFailure, summarizeDraftFailures, type DraftFailure } from "./draftDiagnosis";
import { classifyExistingPublications, readPublishedRecoveryValidators, type ExistingPublications, type PublishedRecoveryValidator } from "./existingPublications";
import { collectAccountRecoveryRequests, type AccountRecoveryRequest, type OnChainPendingRecovery } from "./accountRecoveryRequests";
import { AccountRecoveryRequestsPanel } from "./AccountRecoveryRequestsPanel";
import { RecoveryLookupPanel } from "./RecoveryLookupPanel";
import { RecoveryStepper, recoveryViewStage } from "./RecoveryStepper";
import { GasPayerChoice } from "./GasPayerChoice";
import { RecoveryProposalSessionView } from "./RecoveryProposalSessionView.tsx";
import { safeRecoveryMessage } from "./recoveryMessages.ts";
import { shortStage } from "./recoveryStage.ts";
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
  const { publicClients, runtime, pendingOperations, guardianRoster } = useAppServices();
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
      const liveAccountHandle = await readAccountHandle({
        factory: deployment.factory,
        account: getAddress(account),
        stateTransport: createRpcStateTransport({ endpoint: config.rpcUrl }),
        verificationStateTransport: createRpcStateTransport({ endpoint: config.verificationRpcUrl })
      });
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
          if (!liveAccountHandle) throw new Error("This account has no registered account handle.");
          await assertRecoveryPasskeyUsable({
            passkey: local.passkey,
            deployment,
            accountHandle: liveAccountHandle,
            rpId: local.rpId,
            origin: local.origin,
            assertUsable: assertRegisteredBrowserPasskey
          });
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
      const roster = await guardianRoster.read(accountId);
      if (!rosterMatchesRoot({ entries: roster.entries, threshold: live.guardianThreshold, root: live.guardianRoot })) {
        throw new Error("This device does not hold the current guardian roster, so it cannot choose the set this recovery rotates to. Restore its encrypted guardian backup first.");
      }
      const chosen: RecoveryDraftRotation = Object.freeze({
        entries: withFreshSalts(roster.entries),
        threshold: live.guardianThreshold
      });
      const accountHandle = await readAccountHandle({
        factory: inspection.deployment.factory,
        account: inspection.account,
        stateTransport: createRpcStateTransport({ endpoint: config.rpcUrl }),
        verificationStateTransport: createRpcStateTransport({ endpoint: config.verificationRpcUrl })
      });
      if (!accountHandle) {
        throw new Error("This account has no handle in the configured factory and cannot use the recovery credential format.");
      }
      const prepared = await prepareNewRecoveryPasskey({
        deployment: inspection.deployment,
        label: passkeyLabel,
        account: inspection.account,
        accountHandle,
        rpId: window.location.hostname,
        origin: window.location.origin,
        register: registerBrowserPasskey,
        assertUsable: assertRegisteredBrowserPasskey,
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
      const roster = await guardianRoster.read(accountId);
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
        recoveryPasskeyVerified: true,
        initData: passkeyPreparation.initData,
        credentialId: passkeyPreparation.passkey.credentialId,
        publicKey: passkeyPreparation.passkey.publicKey,
        rpId: passkeyPreparation.rpId,
        origin: passkeyPreparation.origin,
        accountHandle: passkeyPreparation.passkey.accountHandle,
        backupEligible: passkeyPreparation.passkey.backupEligible,
        backedUp: passkeyPreparation.passkey.backedUp,
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
      {inspection.status === "protected" && inspection.deployment.recoveryValidatorProvisioner && showPasskey && !onChainPending?.pending && <div className="callout success"><strong>Permissionless validator provisioning is verified.</strong><p>The deployment publishes the factory and child bytecode commitments required for a new recovery passkey.</p></div>}
      {inspection.status === "protected" && showPasskey && onChainPending?.pending && <div className="callout success">
        <strong>This account already has a recovery under way.</strong>
        <p>
          A recovery passkey was published and the guardians approved it, so there is nothing to create here.
          Its stage and what to do next are below.
        </p>
      </div>}
      {inspection.status === "protected" && showPasskey && !onChainPending?.pending && <div className="recovery-passkey-stage">
        <p className="eyebrow">Step 2 of 4</p><h2>Create a new recovery passkey</h2>
        {publications.kind === "orphaned" && <p className="callout warning"><strong>A recovery passkey was already published for this account.</strong> {publications.message}</p>}
        {/* A scan that could not reach the start of the chain has found nothing
            and proved nothing. Rendering that as silence would let the reader
            believe the check ran when it only ran partway. */}
        {draftFailures.length > 0 && <p className="callout warning">
          <strong>This device holds recovery drafts it could not use.</strong> {summarizeDraftFailures(draftFailures)}
          {" "}A draft that fails here is a storage problem, not a lost passkey — publishing another validator
          would cost gas without addressing it.
        </p>}
        {publications.kind === "unknown" && <p className="callout">
          {/* Shortened once already, into uselessness: "this is not proof" is
              true and tells the reader nothing they can act on. What matters is
              what an unfinished search costs them. */}
          <strong>This account may already have a recovery passkey.</strong>{" "}
          None was found, but the search could not reach the start of the chain, so it cannot rule one out.
          Creating another costs gas for a validator you may not need. An RPC endpoint that serves the full
          log history would settle it.
        </p>}
        {!passkeyPreparation && <><label className="field"><span>Passkey name</span><input value={passkeyLabel} maxLength={80} onChange={event => setPasskeyLabel(event.target.value)} /></label><div className="landing-actions"><button className="secondary" onClick={() => setShowPasskey(false)}>Back</button><button className="primary" disabled={passkeyStatus === "creating"} onClick={() => void createPasskey()}>{passkeyStatus === "creating" ? "Creating passkey…" : "Create recovery passkey"}</button></div></>}
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
      && <RecoveryLookupPanel fixedAccount={inspection.account} accounts={accounts} />}
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
