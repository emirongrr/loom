import type {
  AccountLifecycleClient,
  LifecycleCallEncoder,
  LifecycleIntent,
  Hex
} from "@loom/account";
import type {
  KohakuHost,
  KohakuProviderProfile,
  MetadataBudget,
  PrivacyContext,
  ShieldedPoolAdapter
} from "@loom/privacy";

export class InvalidSdkRequestError extends Error {
  readonly details: Record<string, unknown>;
}

export interface KohakuRuntime {
  readonly host: KohakuHost;
  readonly providerProfile: KohakuProviderProfile;
  readonly providerConsentKey: string;
  metadataBudget(context: PrivacyContext): Promise<MetadataBudget>;
  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function createKohakuRuntime(options: { host: KohakuHost }): KohakuRuntime;

export interface AppScope {
  readonly applicationId: string;
  readonly origin: string;
  readonly chainId: number;
  readonly account?: Hex;
  readonly label?: string;
}

export interface AppScopeManager {
  scopeForOrigin(input: string | {
    origin: string;
    chainId?: number;
    account?: Hex;
    label?: string;
  }): AppScope;
  bindPrivacyContext(context: PrivacyContext, scope: AppScope): PrivacyContext;
}

export function createAppScopeManager(options?: {
  chainId?: number;
  account?: Hex;
}): AppScopeManager;

export interface ClearSigningReview {
  readonly title: string;
  readonly kind: string;
  readonly chainId: number;
  readonly account?: Hex;
  readonly risk: string;
  readonly requiresUserSignature: boolean;
  readonly requiresGuardianApproval: boolean;
  readonly delayRequired: boolean;
  readonly metadataBudgetRequired: boolean;
  readonly optionalInfrastructure: boolean;
  readonly summary: string;
}

export interface WalletCapabilities {
  readonly [chainId: `0x${string}`]: {
    readonly atomic?: {
      readonly status: "supported" | "ready" | "unsupported";
    };
  };
}

export interface LoomSdk {
  readonly lifecycle: AccountLifecycleClient;
  readonly encoders: LifecycleCallEncoder;
  readonly kohaku: KohakuRuntime;
  readonly appScopes: AppScopeManager;
  readonly clearSigning: {
    explainIntent(intent: LifecycleIntent): ClearSigningReview;
  };
  buildAppSessionGrant(input: AppSessionGrantInput): AppSessionGrantIntent;
  preparePrivateVaultWithdrawal(input: PrivateVaultWithdrawalPreparationInput): Promise<PrivateVaultWithdrawalPreparation>;
}

export function createLoomSdk(options?: {
  chainId?: number;
  account?: Hex;
  kohaku?: { host: KohakuHost };
}): LoomSdk;

export interface LoomSignerAdapter {
  signUserOperation(envelope: UserOperationEnvelope): Promise<Hex>;
}

export interface LoomTransportAdapter {
  sendUserOperation(envelope: UserOperationEnvelope): Promise<{
    userOpHash: Hex;
    receipt?: unknown;
  }>;
  estimateUserOperationGas?(envelope: UserOperationEnvelope): Promise<UserOperationGasEstimate>;
  getUserOperationReceipt?(input: { userOpHash: Hex }): Promise<UserOperationReceipt | null>;
  waitForUserOperationReceipt?(input: {
    userOpHash: Hex;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<UserOperationReceipt>;
}

export interface LoomStateReadTransport {
  ethCall(input: {
    to: Hex;
    data: Hex;
    blockTag?: "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;
  }): Promise<Hex>;
  getCode?(input: {
    address: Hex;
    blockTag?: "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;
  }): Promise<Hex>;
}

export interface VerificationProfile {
  readonly status: "verified" | "unverified";
  readonly source: string;
  readonly blockTag?: "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;
  readonly assumptions: readonly string[];
}

export interface VerifiedState<T> {
  readonly status: "verified";
  readonly value: T;
  readonly verification: VerificationProfile & { readonly status: "verified" };
}

export interface UnverifiedState<T = unknown> {
  readonly status: "unverified";
  readonly value?: T;
  readonly reason: string;
  readonly verification: VerificationProfile & { readonly status: "unverified" };
}

export interface Eip1193Provider {
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

export type AccountSafetyStatus =
  | "guardian-protected"
  | "unprotected-recovery"
  | "pending-recovery"
  | "pending-migration"
  | "frozen";

export interface PendingMigrationState {
  readonly active: boolean;
  readonly destination: Hex;
  readonly destinationCodeHash: Hex;
  readonly destinationConfigHash: Hex;
  readonly callsHash: Hex;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
  readonly configVersion: bigint;
  readonly nonce: bigint;
}

export interface PendingRecoveryState {
  readonly active: boolean;
  readonly oldValidatorsHash: Hex;
  readonly newValidator: Hex;
  readonly initDataHash: Hex;
  readonly newGuardianRoot: Hex;
  readonly newGuardianThreshold: number;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
  readonly configVersion: bigint;
  readonly nonce: bigint;
}

export interface AccountSafetyState {
  readonly kind: "account.safetyState";
  readonly chainId: number;
  readonly account: Hex;
  readonly blockTag: string;
  readonly status: AccountSafetyStatus;
  readonly recoveryConfigured: boolean;
  readonly config: {
    readonly guardianRoot: Hex;
    readonly guardianThreshold: number;
    readonly configVersion: bigint;
    readonly validatorCount: bigint;
  };
  readonly freeze: {
    readonly frozenUntil: bigint;
    readonly active: boolean;
  };
  readonly pending: {
    readonly recovery?: PendingRecoveryState;
    readonly migration: PendingMigrationState;
  };
  readonly coverage: {
    readonly account: true;
    readonly migration: true;
    readonly recovery: boolean;
    readonly recoveryModule?: Hex;
  };
  readonly warnings: readonly string[];
  readonly review: {
    readonly title: string;
    readonly risk: AccountSafetyStatus;
    readonly summary: string;
    readonly warnings: readonly string[];
  };
}

export interface LoomCall {
  readonly target: Hex;
  readonly value?: bigint | string | number;
  readonly data: Hex;
}

export interface ViemCall {
  readonly to: Hex;
  readonly value: bigint;
  readonly data: Hex;
}

export interface LoomPreparedIntent {
  readonly kind: string;
  readonly intent: LifecycleIntent | AccountCallsIntent | AppSessionGrantIntent;
  readonly intentHash: Hex;
  readonly review: ClearSigningReview;
}

export interface WalletSendCallsPreparation extends LoomPreparedIntent {
  readonly kind: "wallet_sendCalls.prepare";
  readonly version: "2.0.0";
  readonly id: string;
  readonly chainId: `0x${string}`;
  readonly atomicRequired: boolean;
  readonly intent: AccountCallsIntent;
  readonly capabilities: {
    readonly atomic: {
      readonly status: "supported";
    };
  };
}

export interface WalletSendCallsInput {
  readonly version?: "2.0.0";
  readonly id?: string;
  readonly from?: Hex;
  readonly chainId?: `0x${string}`;
  readonly requestChainId?: `0x${string}`;
  readonly chainIdHex?: `0x${string}`;
  readonly atomicRequired?: boolean;
  readonly calls: readonly {
    readonly to?: Hex;
    readonly target?: Hex;
    readonly value?: bigint | string | number;
    readonly data?: Hex;
    readonly capabilities?: Record<string, { optional?: boolean; [key: string]: unknown }>;
  }[];
  readonly capabilities?: Record<string, { optional?: boolean; [key: string]: unknown }>;
}

export interface AccountCallsIntent {
  readonly kind: "account.calls";
  readonly chainId: number;
  readonly account: Hex;
  readonly calls: readonly {
    readonly target: Hex;
    readonly value: bigint;
    readonly data: Hex;
  }[];
  readonly authority: {
    readonly risk: "account-execution" | string;
    readonly requiresUserSignature: true;
    readonly requiresGuardianApproval: false;
    readonly delayRequired: false;
  };
}

export interface UserOperationEnvelope {
  readonly kind: "userOperation.prepare";
  readonly chainId: number;
  readonly account: Hex;
  readonly intent: LifecycleIntent | AccountCallsIntent | AppSessionGrantIntent;
  readonly intentHash: Hex;
  readonly userOperation: {
    readonly sender: Hex;
    readonly nonce: bigint;
    readonly factory?: Hex;
    readonly factoryData?: Hex;
    readonly callData: Hex;
    readonly callGasLimit: bigint;
    readonly verificationGasLimit: bigint;
    readonly preVerificationGas: bigint;
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
    readonly paymaster?: Hex;
    readonly paymasterData?: Hex;
    readonly signature: Hex;
  };
  readonly review: ClearSigningReview;
}

export interface UserOperationGasEstimate {
  readonly callGasLimit: bigint;
  readonly verificationGasLimit: bigint;
  readonly preVerificationGas: bigint;
}

export interface UserOperationReceipt {
  readonly userOpHash: Hex;
  readonly success: boolean;
  readonly receipt?: unknown;
  readonly [key: string]: unknown;
}

export interface LoomClient {
  readonly account: Hex;
  readonly chainId: number;
  readonly sdk: LoomSdk;
  prepareDeployAccount(input: {
    factory: Hex;
    salt: Hex;
    initCode?: Hex;
    recoveryStatus?: "guardian-protected" | "unprotected";
  }): LoomPreparedIntent & {
    readonly factory: Hex;
    readonly salt: Hex;
    readonly initCode: Hex;
    readonly recoveryStatus: "guardian-protected" | "unprotected";
  };
  prepareCalls(input: {
    calls: readonly LoomCall[];
    risk?: string;
  }): LoomPreparedIntent & {
    readonly intent: AccountCallsIntent;
  };
  getCapabilities(input?: {
    address?: Hex;
    chainIds?: readonly (`0x${string}` | number)[];
  }): WalletCapabilities;
  prepareWalletSendCalls(input: WalletSendCallsInput): WalletSendCallsPreparation;
  prepareUserOperation(
    prepared: LoomPreparedIntent | LifecycleIntent | AccountCallsIntent,
    overrides?: UserOperationOverrides
  ): UserOperationEnvelope;
  toViemCalls(prepared: LoomPreparedIntent | LifecycleIntent | AccountCallsIntent): readonly ViemCall[];
  sendPreparedUserOperation(
    prepared: LoomPreparedIntent | LifecycleIntent | AccountCallsIntent,
    overrides?: UserOperationOverrides & {
      signer?: LoomSignerAdapter;
      transport?: LoomTransportAdapter;
    }
  ): Promise<{ userOpHash: Hex; receipt?: unknown }>;
  sendCalls(
    input: { calls: readonly LoomCall[]; risk?: string },
    overrides?: UserOperationOverrides & {
      signer?: LoomSignerAdapter;
      transport?: LoomTransportAdapter;
    }
  ): Promise<{ userOpHash: Hex; receipt?: unknown }>;
  sendWalletCalls(
    input: WalletSendCallsInput,
    overrides?: UserOperationOverrides & {
      signer?: LoomSignerAdapter;
      transport?: LoomTransportAdapter;
    }
  ): Promise<{
    id: string;
    userOpHash: Hex;
    capabilities: {
      atomic: {
        status: "supported";
      };
    };
  }>;
  sendCallsAndWait(
    input: { calls: readonly LoomCall[]; risk?: string },
    overrides?: UserOperationOverrides & {
      signer?: LoomSignerAdapter;
      transport?: LoomTransportAdapter;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ): Promise<{ userOpHash: Hex; receipt: UserOperationReceipt }>;
  estimateCalls(
    input: { calls: readonly LoomCall[]; risk?: string },
    overrides?: UserOperationOverrides & {
      transport?: LoomTransportAdapter;
    }
  ): Promise<UserOperationGasEstimate>;
  waitForUserOperationReceipt(
    input: { userOpHash: Hex },
    overrides?: {
      transport?: LoomTransportAdapter;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ): Promise<UserOperationReceipt>;
  readSafetyState(input?: {
    stateTransport?: LoomStateReadTransport;
    transport?: LoomStateReadTransport;
    recoveryModule?: Hex;
    blockTag?: "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;
    now?: bigint | string | number;
  }): Promise<AccountSafetyState>;
  grantSession(input: AppSessionGrantInput): LoomPreparedIntent & {
    readonly intent: AppSessionGrantIntent;
  };
  revokeSession(input: Parameters<AccountLifecycleClient["buildSessionRevoke"]>[0]): LoomPreparedIntent;
  proposeRecovery(input: Parameters<AccountLifecycleClient["buildRecoveryProposal"]>[0]): LoomPreparedIntent;
  cancelRecovery(input: Parameters<AccountLifecycleClient["buildRecoveryCancellation"]>[0]): LoomPreparedIntent;
  executeRecovery(input: Parameters<AccountLifecycleClient["buildRecoveryExecution"]>[0]): LoomPreparedIntent;
  scheduleVaultWithdrawal(input: Parameters<AccountLifecycleClient["buildVaultWithdrawal"]>[0]): LoomPreparedIntent;
  preparePrivateVaultWithdrawal(input: PrivateVaultWithdrawalPreparationInput): Promise<PrivateVaultWithdrawalPreparation>;
}

export interface UserOperationOverrides {
  nonce?: bigint | string | number;
  callData?: Hex;
  factory?: Hex;
  factoryData?: Hex;
  callGasLimit?: bigint | string | number;
  verificationGasLimit?: bigint | string | number;
  preVerificationGas?: bigint | string | number;
  maxFeePerGas?: bigint | string | number;
  maxPriorityFeePerGas?: bigint | string | number;
  paymaster?: Hex;
  paymasterData?: Hex;
  signature?: Hex;
}

export function createLoomClient(options: {
  chainId: number;
  account: Hex;
  sdk?: LoomSdk;
  kohaku?: { host: KohakuHost };
  signer?: LoomSignerAdapter;
  transport?: LoomTransportAdapter;
  stateTransport?: LoomStateReadTransport;
  middleware?: readonly ((envelope: UserOperationEnvelope) => Promise<UserOperationEnvelope> | UserOperationEnvelope)[];
}): LoomClient;

export function walletGetCapabilities(input: {
  account: Hex;
  chainId: number;
  address?: Hex;
  chainIds?: readonly (`0x${string}` | number)[];
}): WalletCapabilities;

export function prepareWalletSendCalls(input: WalletSendCallsInput & {
  account: Hex;
  enabledChainId?: number;
  localChainId?: number;
}): WalletSendCallsPreparation;

export interface BundlerTransportOptions {
  endpoint: string;
  entryPoint: Hex;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  requestId?: number | string;
  pollIntervalMs?: number;
}

export function createBundlerTransport(options: BundlerTransportOptions): LoomTransportAdapter & {
  readonly endpoint: string;
  readonly entryPoint: Hex;
};

export interface RpcStateTransportOptions {
  endpoint: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  requestId?: number | string;
}

export function createRpcStateTransport(options: RpcStateTransportOptions): LoomStateReadTransport & {
  readonly endpoint: string;
};

export function createEip1193StateTransport(options: {
  provider: Eip1193Provider;
  verification?: Partial<VerificationProfile>;
}): LoomStateReadTransport & {
  readonly provider: Eip1193Provider;
  readonly verification: VerificationProfile;
  describeVerification(): VerificationProfile;
};

export function verified<T>(value: T, profile?: Partial<VerificationProfile>): VerifiedState<T>;

export function unverified<T = unknown>(
  reason: string,
  value?: T,
  profile?: Partial<VerificationProfile>
): UnverifiedState<T>;

export function readAccountSafetyState(input: {
  chainId: number;
  account: Hex;
  stateTransport?: LoomStateReadTransport;
  transport?: LoomStateReadTransport;
  recoveryModule?: Hex;
  blockTag?: "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;
  now?: bigint | string | number;
}): Promise<AccountSafetyState>;

export interface VaultPolicyState {
  readonly dailyLimit: bigint;
  readonly period: bigint;
  readonly delay: bigint;
  readonly enabled: boolean;
}

export function readVaultPolicyState(input: {
  account: Hex;
  vaultHook: Hex;
  token: Hex;
  stateTransport?: LoomStateReadTransport;
  transport?: LoomStateReadTransport;
  blockTag?: "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;
}): Promise<VaultPolicyState>;

export function toViemCalls(
  prepared: LoomPreparedIntent | LifecycleIntent | AccountCallsIntent,
  options?: { account?: Hex }
): readonly ViemCall[];

export interface PasskeyChallenge {
  readonly type: "loom.passkey-user-operation";
  readonly credentialId: string;
  readonly rpId: string;
  readonly origin?: string;
  readonly account: Hex;
  readonly chainId: number;
  readonly intentHash: Hex;
  readonly userOperationHash: Hex;
}

export interface PasskeyAssertion {
  readonly authenticatorData: Hex;
  readonly clientDataJSON: Hex;
  readonly signature: Hex;
  readonly userHandle?: Hex;
}

export function createPasskeySigner(options: {
  credentialId: string;
  rpId: string;
  origin?: string;
  signChallenge(challenge: PasskeyChallenge): Promise<PasskeyAssertion>;
}): LoomSignerAdapter & {
  readonly credentialId: string;
  readonly rpId: string;
  readonly origin?: string;
};

export function prepareUserOperationEnvelope(input: {
  chainId: number;
  account: Hex;
  intent: LifecycleIntent | AccountCallsIntent | AppSessionGrantIntent;
} & UserOperationOverrides): UserOperationEnvelope;

export interface AppSessionGrantInput {
  lifecycle?: AccountLifecycleClient;
  appScopes?: AppScopeManager;
  appScope?: AppScope;
  origin?: string;
  label?: string;
  chainId?: number;
  account?: Hex;
  sessionKey: Hex;
  target: Hex;
  selector: Hex;
  token: Hex;
  maxAmount: bigint | string | number;
  validAfter?: bigint | string | number;
  validUntil: bigint | string | number;
  maxUses: number;
  callData?: Hex;
}

export interface AppSessionGrantIntent extends LifecycleIntent {
  readonly kind: "session.grant";
  readonly appScope: {
    readonly applicationId: string;
    readonly chainId: number;
    readonly account?: Hex;
    readonly label?: string;
  };
  readonly appBindingHash: Hex;
  readonly review: ClearSigningReview;
}

export function buildAppSessionGrant(options: AppSessionGrantInput): AppSessionGrantIntent;

export interface PrivateVaultWithdrawalPreparationInput {
  lifecycle?: AccountLifecycleClient;
  appScopes?: AppScopeManager;
  appScope?: AppScope;
  adapter: ShieldedPoolAdapter;
  method?: "shield" | "unshield" | "privateTransfer" | "buildOperation";
  context: PrivacyContext;
  privateRequest?: Record<string, unknown>;
  vault: {
    token: Hex;
    recipient: Hex;
    amount: bigint | string | number;
    executeAfter: bigint | string | number;
    expiry?: bigint | string | number;
    callData?: Hex;
    hook?: Hex;
    stateTransport?: LoomStateReadTransport;
    transport?: LoomStateReadTransport;
    blockTag?: "latest" | "safe" | "finalized" | "pending" | "earliest" | `0x${string}` | number | bigint;
  };
}

export type VaultProtectionResult =
  | { readonly verified: false; readonly reason: string }
  | { readonly verified: true; readonly policy: VaultPolicyState };

export interface PrivateVaultWithdrawalPreparation {
  readonly intent: LifecycleIntent;
  readonly operation: {
    readonly protocol: string;
    readonly chainId: number;
    readonly calls: readonly {
      readonly target: Hex;
      readonly value: bigint;
      readonly data: Hex;
    }[];
    readonly metadataBudget: MetadataBudget;
    readonly operation: unknown;
    readonly requiresVaultDelay: boolean;
    readonly requiresBridgeFinality?: string;
  };
  readonly vaultProtection: VaultProtectionResult;
  readonly hashes: {
    readonly privateOperationHash: Hex;
    readonly metadataBudgetHash: Hex;
  };
  readonly review: ClearSigningReview;
}

export function preparePrivateVaultWithdrawal(
  options: PrivateVaultWithdrawalPreparationInput
): Promise<PrivateVaultWithdrawalPreparation>;

export function explainLifecycleIntent(intent: LifecycleIntent): ClearSigningReview;

export function hashCanonical(value: unknown): Hex;
