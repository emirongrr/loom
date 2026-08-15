import { useEffect, useMemo, useState } from "react";
import { GuardianRecoveryError, createRecoveryRequest, parseRecoveryRequest, parseRecoveryResponse, serializeRecoveryProtocol, type GuardianApprovalTuple, type RecoveryRequestV1 } from "@loom/sdk/recovery";
import { getAddress, isAddress } from "viem";
import { useAppServices } from "../../app/AppServices";
import { useNetwork } from "../../config/NetworkContext";
import { loadWalletDeployment, registerBrowserPasskey } from "../onboarding/accountLifecycle";
import { createAccountGuardianClient } from "../security/guardianClient";
import { createEncryptedLinkTransport } from "../../transports/invitations";
import {
  createRecoverySession, createRecoverySessionRepository, transitionRecoverySession, type RecoverySession, type RecoverySessionIssue, type RecoverySessionRepository
} from "./recoverySession";
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
import { createRecoveryDraft, createRecoveryDraftRepository, restoreRecoveryDraftPreparation } from "./recoveryDraft";
import { RecoveryStepper, recoveryViewStage } from "./RecoveryStepper";
import { useRecoverySetupController } from "./useRecoverySetupController";

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
  const [sessions, setSessions] = useState<readonly RecoverySession[]>([]);
  const [issues, setIssues] = useState<readonly RecoverySessionIssue[]>([]);
  const [message, setMessage] = useState("");
  const [passkeyLabel, setPasskeyLabel] = useState("Recovered wallet");
  const [gasPayerId, setGasPayerId] = useState("");
  const selectedId = sessionIdFromPath(path);
  const selected = path.startsWith("/recover/") ? sessions.find(session => session.id === selectedId) : undefined;
  const gasPayers = inspection.status === "protected"
    ? recoveryGasPayers(accounts, inspection.deployment.chainId, inspection.account)
    : [];
  const preferredGasPayer = accounts.find(candidate => candidate.id === preferredGasPayerId);
  const selectedGasPayer = selectRecoveryGasPayer(gasPayers, gasPayerId || preferredGasPayerId);

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
      const drafts = (await draftRepository.inspect()).drafts.filter(draft =>
        draft.chainId === deployment.chainId
        && draft.account.toLowerCase() === account.toLowerCase()
        && draft.configVersion === state.configVersion.toString()
      );
      for (const draft of drafts) {
        try {
          const local = restoreRecoveryDraftPreparation(draft);
          const checked = await client.prepareRecoveryValidator({ initData: local.initData });
          if (checked.validator !== local.validator || checked.initDataHash !== local.initDataHash) continue;
          setPasskeyLabel(draft.label);
          setPasskeyPreparation(Object.freeze({ ...local, ...checked }));
          setShowPasskey(true);
          setPasskeyStatus(checked.alreadyDeployed ? "published" : "prepared");
          setMessage(checked.alreadyDeployed ? "Your encrypted recovery draft matched the live validator deployment. Continue with guardian approvals." : "Your encrypted recovery passkey draft was restored. Publish its exact validator call to continue.");
          break;
        } catch { /* A stale draft cannot hide another healthy draft or the live account state. */ }
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
      const prepared = await prepareNewRecoveryPasskey({
        deployment: inspection.deployment,
        label: passkeyLabel,
        rpId: window.location.hostname,
        origin: window.location.origin,
        register: registerBrowserPasskey,
        prepare: input => client.prepareRecoveryValidator(input)
      });
      await draftRepository.write(createRecoveryDraft({
        chainId: inspection.deployment.chainId,
        account: inspection.account,
        configVersion: inspection.configVersion,
        label: passkeyLabel.trim(),
        preparation: prepared
      }));
      setPasskeyPreparation(prepared);
      setPasskeyStatus(prepared.alreadyDeployed ? "published" : "prepared");
    } catch (error) {
      setPasskeyStatus("idle");
      setMessage(safeRecoveryMessage(error));
    }
  };

  const verifyPublication = async () => {
    if (!passkeyPreparation) return;
    const checked = await recoveryClient().prepareRecoveryValidator({ initData: passkeyPreparation.initData });
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
      const freshGuardianEntries = withFreshSalts(roster.entries);
      const newGuardianSet = planGuardianChange({ current: roster.entries, next: freshGuardianEntries, threshold: live.guardianThreshold }).set;
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

  if (selected) return <RecoveryProposalSessionView session={selected} repository={repository} onChanged={refresh} onRecovered={onRecovered} onBack={() => onNavigate("/recover")} />;

  return <main className="wallet-landing recovery-layout">
    <section className="landing-panel" aria-labelledby="recovery-title">
      <div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div>
      <p className="eyebrow">Self-sovereign recovery</p>
      <h1 id="recovery-title">Recover account control</h1>
      <p>Recovery replaces account validators only after the existing guardian threshold approves, the on-chain delay completes, and the exact reviewed request still matches live state.</p>
      {preferredGasPayer && <div className="callout success"><strong>{sourceWalletOpen ? `${preferredGasPayer.label} remains open.` : `${preferredGasPayer.label} is selected as gas payer.`}</strong><p>You entered recovery from {shortAddress(preferredGasPayer.account)}. It is preselected to pay the factory gas when the recovery target is a different account, and its passkey will be requested only when publishing.</p></div>}
      <RecoveryStepper stage={recoveryViewStage({ showingPasskey: showPasskey })} />
      {!showPasskey && <><label className="field"><span>Account to recover</span><input value={account} onChange={event => { setAccount(event.target.value); setInspection({ status: "idle" }); setPasskeyPreparation(null); }} placeholder="0x…" spellCheck={false} /></label>
      <div className="landing-actions"><button className="secondary" onClick={onClose}>{preferredGasPayer && sourceWalletOpen ? `Return to ${preferredGasPayer.label}` : "Back to wallets"}</button><button className="primary" disabled={inspection.status === "loading"} onClick={() => void inspect()}>{inspection.status === "loading" ? "Checking live state…" : "Check recovery"}</button></div></>}
      {inspection.status === "protected" && <div className="callout success"><strong>Guardian recovery is active.</strong><p>{inspection.threshold} approvals required · config version {inspection.configVersion} · {inspection.validators} validator(s)</p></div>}
      {inspection.status === "protected" && preferredGasPayer?.chainId === inspection.deployment.chainId && preferredGasPayer.account.toLowerCase() === inspection.account.toLowerCase() && <div className="callout warning"><strong>This wallet is the recovery target.</strong><p>It cannot pay its own recovery factory gas while its old passkey is unavailable. Choose another Saved Wallet in the publication step.</p></div>}
      {inspection.status === "protected" && !inspection.deployment.recoveryValidatorProvisioner && <div className="callout warning"><strong>New validator provisioning is unavailable.</strong><p>This deployment does not publish a trusted one-time recovered-validator provisioning path. Recovery stops safely before creating a passkey, request, approval, or transaction.</p><code>UNSUPPORTED_RECOVERED_VALIDATOR_PATH</code></div>}
      {inspection.status === "protected" && inspection.deployment.recoveryValidatorProvisioner && showPasskey && <div className="callout success"><strong>Permissionless validator provisioning is verified.</strong><p>The deployment publishes the factory and child bytecode commitments required for a new recovery passkey.</p></div>}
      {inspection.status === "protected" && showPasskey && <div className="recovery-passkey-stage">
        <p className="eyebrow">Step 2 of 4</p><h2>Create a new recovery passkey</h2>
        <p>This passkey becomes authoritative only after guardian approval, the on-chain delay, and recovery execution. Your current validators remain unchanged now.</p>
        {!passkeyPreparation && <><p className="callout warning">A validator deployment alone cannot restore its passkey metadata. If this recovery was started before encrypted drafts were supported, create one new recovery passkey; this attempt will be saved before any factory transaction and will resume after reload.</p><label className="field"><span>Passkey name</span><input value={passkeyLabel} maxLength={80} onChange={event => setPasskeyLabel(event.target.value)} /></label><div className="landing-actions"><button className="secondary" onClick={() => setShowPasskey(false)}>Back</button><button className="primary" disabled={passkeyStatus === "creating"} onClick={() => void createPasskey()}>{passkeyStatus === "creating" ? "Creating passkey…" : "Create recovery passkey"}</button></div></>}
        {passkeyPreparation && <><div className="callout"><strong>Recovery validator</strong><p className="breakable">{passkeyPreparation.validator}</p></div>
          {passkeyStatus !== "published" ? <><p className="form-note">Publishing this exact factory call is permissionless and grants no account authority. The publishing wallet only pays network gas.</p>
            {gasPayers.length > 0 && <div className="callout"><label className="field"><span>Pay gas with a saved Loom wallet</span><select value={selectedGasPayer?.id ?? ""} onChange={event => setGasPayerId(event.target.value)} disabled={passkeyStatus === "publishing"}>{gasPayers.map(payer => <option key={payer.id} value={payer.id}>{payer.label} · {shortAddress(payer.account)}</option>)}</select></label><p className="form-note">The selected wallet will request its own passkey and sign only the factory deployment call.</p><button className="primary" disabled={passkeyStatus === "publishing" || !selectedGasPayer} onClick={() => void publishWithLoomWallet()}>{passkeyStatus === "publishing" ? "Confirm on your device…" : "Publish & pay with Loom wallet"}</button></div>}
            {gasPayers.length === 0 && <p className="callout warning">No other Saved Wallet on this chain is available. Save and activate another Loom wallet, or use an external publisher.</p>}
            <div className="guardian-actions"><button className="secondary" onClick={() => void copyPublication()}>Copy exact transaction</button><button className="secondary" onClick={() => void verifyPublication().catch(error => setMessage(error instanceof Error ? error.message : "Publication could not be verified."))}>Check publication</button><button className="secondary" disabled={passkeyStatus === "publishing"} onClick={() => void publish()}>{passkeyStatus === "publishing" ? "Publishing…" : "Use external browser wallet"}</button></div></> : <><div className="callout success"><strong>New passkey validator is live.</strong><p>The exact child bytecode is verified on chain.</p></div><button className="primary" onClick={() => void prepareGuardianRequest()}>Continue to guardian approvals</button></>}
        </>}
      </div>}
      {inspection.status === "blocked" && <p className="callout warning">{inspection.message}</p>}
      {message && <p className="callout warning" role="status">{message}</p>}
    </section>

    <section className="saved-wallets" aria-labelledby="recovery-sessions-title">
      <div className="section-heading"><div><p className="eyebrow">Encrypted on this device</p><h2 id="recovery-sessions-title">Recovery sessions</h2></div><span className="pill">{sessions.length}</span></div>
      {issues.length > 0 && <p className="callout warning">{issues.length} unreadable local record(s) were isolated. Healthy sessions remain available.</p>}
      {sessions.length === 0 ? <div className="empty-state compact"><h3>No recovery in progress</h3><p>A recovery session will remain here through approval collection, delay, execution, cancellation, or expiry.</p></div> : <div className="wallet-list">{sessions.map(session => <button key={session.id} className="wallet-list-item" onClick={() => onNavigate(`/recover/${encodeURIComponent(session.id)}`)}><span className="identicon" /><span><strong>{shortStage(session.stage)}</strong><small>{session.request.humanCode} · {session.request.account}</small></span><span className="pill pending">Open</span></button>)}</div>}
      <details><summary>Resume from a portable request</summary><p className="form-note">Paste a versioned recovery request received through a file, QR, clipboard, or bearer-link fragment. Unknown, altered, mismatched, and expired fields fail closed.</p><label className="field"><span>Recovery request</span><textarea rows={6} value={artifact} onChange={event => setArtifact(event.target.value)} placeholder='{"format":"loom.recovery-request",…}' /></label><button className="secondary" disabled={!artifact.trim()} onClick={() => void importRequest()}>Verify and save locally</button></details>
    </section>
  </main>;
}

function RecoveryProposalSessionView({ session, repository, onChanged, onRecovered, onBack }: {
  readonly session: RecoverySession;
  readonly repository: RecoverySessionRepository;
  readonly onChanged: () => Promise<void>;
  readonly onRecovered: (handle: AccountHandle) => Promise<void>;
  readonly onBack: () => void;
}) {
  const { config } = useNetwork();
  const { publicClients, runtime } = useAppServices();
  const [message, setMessage] = useState("");
  const [responseArtifact, setResponseArtifact] = useState("");
  const [busy, setBusy] = useState(false);

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
      const response = responseArtifact.trim().startsWith("{")
        ? parseRecoveryResponse(responseArtifact, session.request)
        : parseRecoveryResponse(await createEncryptedLinkTransport<ReturnType<typeof parseRecoveryResponse>>({ origin: window.location.origin, path: "/recover" }).receive(responseArtifact), session.request);
      const context = await rebuild();
      await verifyResponse(response, context);
      const updated = transitionRecoverySession(session, { type: "response-added", response });
      await repository.write(updated);
      await onChanged();
      setResponseArtifact("");
      setMessage("Guardian response verified against live state and saved.");
    } catch (error) { setMessage(safeRecoveryMessage(error)); }
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
      const approvals: GuardianApprovalTuple[] = [];
      for (const response of session.responses) approvals.push(await verifyResponse(response, context));
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

  const download = () => {
    const url = URL.createObjectURL(new Blob([serializeRecoveryProtocol(session.request)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `loom-recovery-${session.request.humanCode}.json`; link.click(); URL.revokeObjectURL(url);
  };
  const copyRequest = async () => {
    try { await navigator.clipboard.writeText(serializeRecoveryProtocol(session.request)); setMessage("Recovery request copied."); }
    catch { setMessage("Clipboard access is unavailable. Export the request file instead."); }
  };
  const copyEncryptedLink = async () => {
    try {
      const delivered = await createEncryptedLinkTransport<RecoveryRequestV1>({ origin: window.location.origin }).deliver(session.request);
      await navigator.clipboard.writeText(delivered.value); setMessage("Recovery bearer link copied. It carries its own decryption key, so anyone with the link can read the request.");
    } catch { setMessage("Recovery link could not be copied. Export the request file instead."); }
  };

  useEffect(() => {
    if (session.stage === "delay-active") void checkPending();
  }, [session.id, session.stage]);

  const canCollect = session.stage === "request-created" || session.stage === "collecting";
  return <main className="wallet-landing lock-layout"><section className="landing-panel"><div className="landing-brand"><span className="brand-mark">L</span><strong>Loom</strong></div><p className="eyebrow">Recovery session · {session.request.humanCode}</p><h1>{shortStage(session.stage)}</h1><p className="breakable">{session.request.account} · Chain {session.request.chainId}</p><div className="permission-grid"><div><span>Approvals</span><strong>{session.responses.length} of {session.request.guardianThreshold}</strong></div><div><span>Config version</span><strong>{session.request.configVersion}</strong></div><div><span>Created</span><strong>{new Date(session.createdAt).toLocaleString()}</strong></div><div><span>Expires</span><strong>{new Date(session.request.expiresAt * 1000).toLocaleString()}</strong></div></div><p className="callout">Compare the six-digit code with every guardian over an independent channel before accepting a response. Every response is checked against live verifier bytecode, the active guardian root, and the exact recovery digest.</p>{message && <p className="callout" role="status">{message}</p>}{canCollect && <div className="recovery-response-import"><label className="field"><span>Guardian response</span><textarea rows={6} value={responseArtifact} onChange={event => setResponseArtifact(event.target.value)} placeholder='{"format":"loom.recovery-response",…}' /></label><button className="secondary" disabled={busy || !responseArtifact.trim()} onClick={() => void importResponse()}>Verify and add response</button></div>}{session.stage === "ready-to-propose" && <div className="callout warning"><strong>Guardian threshold reached.</strong><p>The browser wallet only publishes the permissionless proposal and pays gas. It receives no recovery authority.</p><button className="primary" disabled={busy} onClick={() => void propose()}>{busy ? "Revalidating approvals…" : "Propose recovery on chain"}</button></div>}{session.transactionHash && <div className="callout success"><strong>On-chain recovery proposal</strong><p className="breakable">Proposal transaction {session.transactionHash}</p>{session.readyAt && <p>Ready after {new Date(Number(BigInt(session.readyAt) * 1_000n)).toLocaleString()}</p>}{session.expiresAt && <p>Execution expires {new Date(Number(BigInt(session.expiresAt) * 1_000n)).toLocaleString()}</p>}</div>}{session.stage === "delay-active" && <button className="secondary" disabled={busy} onClick={() => void checkPending()}>{busy ? "Reading chain state…" : "Check on-chain readiness"}</button>}{session.stage === "ready-to-execute" && <div className="callout warning"><strong>Recovery is executable.</strong><p>The contract-enforced delay has elapsed. Execution will atomically replace the validator set and rotate the guardian root.</p><button className="primary" disabled={busy} onClick={() => void execute()}>{busy ? "Verifying pending recovery…" : "Execute recovery"}</button></div>}{session.executionTransactionHash && <div className="callout success"><strong>Recovery executed</strong><p className="breakable">Execution transaction {session.executionTransactionHash}</p><button className="secondary" disabled={busy} onClick={() => void saveRecoveredWallet().then(() => setMessage("Recovered wallet saved.")).catch(error => setMessage(error instanceof Error ? error.message : "Recovered wallet could not be saved."))}>Save recovered wallet</button></div>}<div className="guardian-actions"><button className="secondary" onClick={onBack}>All sessions</button><button className="secondary" onClick={() => void copyRequest()}>Copy request</button><button className="secondary" onClick={() => void copyEncryptedLink()}>Copy bearer link</button><button className="primary" onClick={download}>Export file</button></div></section></main>;
}

function shortStage(stage: RecoverySession["stage"]): string {
  return ({ "request-created": "Request ready", collecting: "Collecting approvals", "ready-to-propose": "Ready to propose", "delay-active": "Security delay active", "ready-to-execute": "Ready to execute", completed: "Recovery completed", cancelled: "Recovery cancelled", expired: "Recovery expired", blocked: "Recovery blocked" })[stage];
}

function shortAddress(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

function safeRecoveryMessage(error: unknown): string {
  if (error instanceof GuardianRecoveryError) return error.safeMessage;
  return "Recovery state could not be verified. Check the account, network, and RPC, then retry.";
}

function sessionIdFromPath(path: string): string {
  if (!path.startsWith("/recover/")) return "";
  try { return decodeURIComponent(path.slice("/recover/".length)); }
  catch { return ""; }
}
