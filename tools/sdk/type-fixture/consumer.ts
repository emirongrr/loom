// Type-integrity fixture: consumes the published type surface of every Loom
// package the way an external integrator would. It is compiled with
// `tsc --noEmit` in CI and never executed; a compile error here means the
// hand-written .d.ts files drifted from the documented API surface.
//
// Keep this fixture in terms of the public package names only. Deep imports
// into package internals defeat the purpose of the gate.

import {
  createLoomSdk,
  createLoomClient,
  createBundlerTransport,
  createRpcStateTransport,
  createPasskeySigner,
  createAppScopeManager,
  readAccountSafetyState,
  readVaultPolicyState,
  prepareWalletSendCalls,
  walletGetCapabilities,
  buildAppSessionGrant,
  prepareUserOperationEnvelope,
  computeUserOperationHash,
  fetchEntryPointNonce,
  explainLifecycleIntent,
  hashCanonical,
  toViemCalls,
  InvalidSdkRequestError,
  type LoomSdk,
  type LoomClient,
  type LoomSignerAdapter,
  type LoomTransportAdapter,
  type LoomStateReadTransport,
  type UserOperationEnvelope,
  type UserOperationReceipt,
  type UserOperationGasEstimate,
  type AccountSafetyState,
  type WalletCapabilities,
  type WalletSendCallsPreparation,
  type ClearSigningReview,
  type AppSessionGrantIntent,
  type PasskeyChallenge,
  type PasskeyAssertion,
  type ViemCall,
  type VaultPolicyState
} from "@loom/sdk";
import {
  createAccountLifecycleClient,
  createLifecycleCallEncoder,
  type AccountLifecycleClient,
  type LifecycleCallEncoder,
  type LifecycleIntent,
  type Hex
} from "@loom/account";
import {
  buildGuardianTree,
  guardianLeaf,
  verifyGuardianProof,
  type GuardianInput,
  type GuardianTree
} from "@loom/guardian";
import {
  createConsentStore,
  createMemoryStorage,
  providerConsentKey,
  type KohakuHost,
  type KohakuProviderProfile,
  type MetadataBudget,
  type PrivacyContext
} from "@loom/privacy";

// Values a real consumer supplies from its own environment. `declare` keeps
// the fixture type-only: nothing here can run.
declare const account: Hex;
declare const sessionKey: Hex;
declare const host: KohakuHost;
declare const providerProfile: KohakuProviderProfile;
declare const privacyContext: PrivacyContext;
declare const lifecycleIntent: LifecycleIntent;
declare const passkeyAssertion: PasskeyAssertion;
declare const guardianInput: GuardianInput;

export async function exerciseSdkSurface(): Promise<void> {
  // Headless construction: chain, account, and explicit adapters only.
  const sdk: LoomSdk = createLoomSdk({ chainId: 1, account, kohaku: { host } });

  const bundler: LoomTransportAdapter = createBundlerTransport({
    endpoint: "https://bundler.example",
    entryPoint: account
  });
  const rpc: LoomStateReadTransport = createRpcStateTransport({
    endpoint: "https://rpc.example"
  });
  const passkey: LoomSignerAdapter = createPasskeySigner({
    credentialId: "credential-id",
    rpId: "wallet.example",
    origin: "https://wallet.example",
    validator: account,
    entryPoint: account,
    async signChallenge(challenge: PasskeyChallenge): Promise<PasskeyAssertion> {
      const boundIntent: Hex = challenge.intentHash;
      void boundIntent;
      return passkeyAssertion;
    }
  });

  const client: LoomClient = createLoomClient({
    chainId: 1,
    account,
    sdk,
    signer: passkey,
    transport: bundler,
    stateTransport: rpc,
    middleware: [async (envelope: UserOperationEnvelope) => envelope]
  });

  // Prepare-review-send flow with clear signing at every step.
  const prepared = client.prepareCalls({
    calls: [{ target: account, value: 0n, data: "0x" }]
  });
  const review: ClearSigningReview = prepared.review;
  void review.requiresGuardianApproval;

  const envelope: UserOperationEnvelope = client.prepareUserOperation(prepared, {
    maxFeePerGas: 1n
  });
  void envelope.userOperation.callData;

  // Canonical hashing and nonce reads are explicit: the EntryPoint and the
  // state transport are always supplied, never defaulted.
  const canonicalOpHash: Hex = computeUserOperationHash(envelope, { entryPoint: account });
  void canonicalOpHash;
  const clientOpHash: Hex = client.computeUserOperationHash(envelope, { entryPoint: account });
  void clientOpHash;
  const entryPointNonce: bigint = await fetchEntryPointNonce({
    stateTransport: rpc,
    entryPoint: account,
    account,
    key: 0n
  });
  void entryPointNonce;
  const clientNonce: bigint = await client.getEntryPointNonce({ entryPoint: account });
  void clientNonce;

  const viemCalls: readonly ViemCall[] = client.toViemCalls(prepared);
  void viemCalls;
  const standaloneViemCalls: readonly ViemCall[] = toViemCalls(prepared, { account });
  void standaloneViemCalls;

  const sent: { userOpHash: Hex } = await client.sendCalls({
    calls: [{ target: account, data: "0x" }]
  });
  void sent.userOpHash;

  // The full send pipeline: fill nonce/fees/gas, sign the canonical hash, send,
  // and receive a typed receipt.
  const filled: UserOperationEnvelope = await client.fillUserOperation(prepared, {
    signer: passkey,
    transport: bundler,
    stateTransport: rpc
  });
  void filled.userOperation.callGasLimit;
  const txResult = await client.sendTransaction(
    { calls: [{ target: account, data: "0x" }] },
    { signer: passkey, transport: bundler, stateTransport: rpc }
  );
  void txResult.userOpHash;
  const gasCost: bigint | undefined = txResult.receipt?.actualGasCost;
  void gasCost;

  const estimate: UserOperationGasEstimate = await client.estimateCalls({
    calls: [{ target: account, data: "0x" }]
  });
  void estimate.verificationGasLimit;

  const receipt: UserOperationReceipt = await client.waitForUserOperationReceipt({
    userOpHash: sent.userOpHash
  });
  void receipt.success;

  // Safety state reads are explicit-transport only.
  const safety: AccountSafetyState = await client.readSafetyState({ stateTransport: rpc });
  void safety.pending.migration.active;
  const standaloneSafety: AccountSafetyState = await readAccountSafetyState({
    chainId: 1,
    account,
    stateTransport: rpc
  });
  void standaloneSafety.status;

  const vaultPolicy: VaultPolicyState = await readVaultPolicyState({
    account,
    vaultHook: account,
    token: account,
    stateTransport: rpc
  });
  void vaultPolicy.dailyLimit;

  // ERC-5792 surface.
  const capabilities: WalletCapabilities = client.getCapabilities();
  void capabilities;
  const standaloneCapabilities: WalletCapabilities = walletGetCapabilities({
    account,
    chainId: 1
  });
  void standaloneCapabilities;
  const walletCalls: WalletSendCallsPreparation = prepareWalletSendCalls({
    account,
    chainId: "0x1",
    calls: [{ to: account, data: "0x" }]
  });
  void walletCalls.capabilities.atomic.status;

  // Session grants bound to an app scope.
  const appScopes = createAppScopeManager({ chainId: 1, account });
  const scope = appScopes.scopeForOrigin("https://app.example");
  const grant: AppSessionGrantIntent = buildAppSessionGrant({
    appScope: scope,
    account,
    chainId: 1,
    sessionKey,
    target: account,
    selector: "0xa9059cbb",
    token: account,
    maxAmount: 1000n,
    validUntil: 1n,
    maxUses: 1
  });
  void grant.appBindingHash;

  // Lifecycle builders and encoders from the account package.
  const lifecycle: AccountLifecycleClient = createAccountLifecycleClient({ chainId: 1, account });
  void lifecycle;
  const encoders: LifecycleCallEncoder = createLifecycleCallEncoder();
  void encoders;
  const intentReview: ClearSigningReview = explainLifecycleIntent(lifecycleIntent);
  void intentReview.summary;
  const standaloneEnvelope: UserOperationEnvelope = prepareUserOperationEnvelope({
    chainId: 1,
    account,
    intent: lifecycleIntent
  });
  void standaloneEnvelope.intentHash;

  // Guardian ceremony primitives.
  const tree: GuardianTree = buildGuardianTree([guardianInput]);
  const leaf: Hex = guardianLeaf(guardianInput);
  const proof: readonly Hex[] = tree.proofFor(leaf);
  const proofValid: boolean = verifyGuardianProof({ root: tree.root, leaf, proof });
  void proofValid;

  // Privacy runtime boundary.
  const consent = createConsentStore([providerConsentKey(providerProfile)]);
  void consent;
  const storage = createMemoryStorage();
  void storage;
  const budget: MetadataBudget = await sdk.kohaku.metadataBudget(privacyContext);
  void budget;

  const canonical: Hex = hashCanonical({ account, chainId: 1 });
  void canonical;
  void InvalidSdkRequestError;
}

// Negative assertions: these must stay compile errors. If one stops erroring,
// the type surface silently widened.
export function exerciseRejectedShapes(): void {
  // @ts-expect-error createLoomClient requires an account
  void createLoomClient({ chainId: 1 });
  // @ts-expect-error bundler transport requires an explicit endpoint
  void createBundlerTransport({ entryPoint: account });
  // @ts-expect-error state transport requires an explicit endpoint
  void createRpcStateTransport({});
}
