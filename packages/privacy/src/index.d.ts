export type Hex = `0x${string}`;

export type ChainId = number;

export type PrivacyProtocol = "railgun" | "aztec" | "stealth" | "privacy-pool" | "custom";

export type KohakuProviderMode = "user-rpc" | "helios" | "colibri" | "local-node" | "custom";

export type MetadataSurface =
  | "rpc"
  | "indexer"
  | "relayer"
  | "prover"
  | "bridge"
  | "timing"
  | "browser-storage"
  | "backup";

export interface MetadataBudgetItem {
  surface: MetadataSurface;
  reveals: string;
  required: boolean;
  mitigation?: string;
}

export interface MetadataBudget {
  protocol: PrivacyProtocol;
  chainId: ChainId;
  items: readonly MetadataBudgetItem[];
  degradedMode?: string;
}

export interface PrivacyContext {
  account: Hex;
  chainId: ChainId;
  applicationId?: string;
  identityHint?: string;
  scanScope?: string;
}

export interface KohakuProviderProfile {
  mode: KohakuProviderMode;
  chainId: ChainId;
  endpoint?: string;
  verified: boolean;
  metadataBudget: MetadataBudget;
}

export interface ConsentStore {
  grant(key: string): void;
  revoke(key: string): void;
  has(key: string): boolean;
  grantProvider(profile: KohakuProviderProfile): void;
  hasProvider(profile: KohakuProviderProfile): boolean;
}

export interface MetadataPolicy {
  allowedSurfaces?: readonly MetadataSurface[];
  forbiddenSurfaces?: readonly MetadataSurface[];
  requireKnownMitigation?: boolean;
  maxRequiredSurfaces?: number;
  forbiddenRevealPatterns?: readonly RegExp[];
}

export interface KohakuHostOptions {
  providerProfile: KohakuProviderProfile;
  fetch?: typeof fetch;
  storage?: KohakuHost["storage"];
  keystore?: KohakuHost["keystore"];
  consentStore?: ConsentStore;
  metadataPolicy?: MetadataPolicy;
}

export interface KohakuHost {
  network: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  storage: {
    set(key: string, value: string): void;
    get(key: string): string | null;
    delete?(key: string): void;
  };
  keystore: {
    deriveAt(path: string): Hex;
  };
  provider: {
    profile: KohakuProviderProfile;
    request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    consentKey: string;
  };
  metadataBudget(context: PrivacyContext): Promise<MetadataBudget>;
}

export class ConsentRequiredError extends Error {
  readonly details: Record<string, unknown>;
}

export class MetadataBudgetExceededError extends Error {
  readonly details: Record<string, unknown>;
}

export class PrivacyAdapterUnavailableError extends Error {
  readonly details: Record<string, unknown>;
}

export class InvalidPrivateOperationError extends Error {
  readonly details: Record<string, unknown>;
}

export class PrivateScanStateError extends Error {
  readonly details: Record<string, unknown>;
}

export class PrivacyAdapterFailureError extends Error {
  readonly details: {
    protocol?: PrivacyProtocol;
    method?: string;
    surface?: MetadataSurface;
    recoverable?: boolean;
    cause?: string;
  };
}

export function providerConsentKey(profile: KohakuProviderProfile): string;

export function createConsentStore(initialKeys?: readonly string[]): ConsentStore;

export function createMemoryStorage(initial?: Record<string, string>): KohakuHost["storage"];

export function createMetadataBudget(input: MetadataBudget): MetadataBudget;

export function createProviderProfile(input: KohakuProviderProfile): KohakuProviderProfile;

export function assertMetadataBudgetAllowed(budget: MetadataBudget, policy?: MetadataPolicy): void;

export interface MetadataLeakageViolation {
  code:
    | "forbidden-surface"
    | "unapproved-required-surface"
    | "missing-mitigation"
    | "secret-reveal-description"
    | "too-many-required-surfaces";
  surface?: MetadataSurface;
  reveals?: string;
  requiredSurfaceCount?: number;
  maxRequiredSurfaces?: number;
}

export interface MetadataLeakageReview {
  protocol: PrivacyProtocol;
  chainId: ChainId;
  approved: boolean;
  requiredSurfaceCount: number;
  surfaces: readonly MetadataSurface[];
  violations: readonly MetadataLeakageViolation[];
}

export interface MetadataLeakageHarness {
  reviewBudget(budget: MetadataBudget): MetadataLeakageReview;
  assertBudget(budget: MetadataBudget): MetadataLeakageReview;
}

export function createMetadataLeakageHarness(policy?: MetadataPolicy): MetadataLeakageHarness;

export function createKohakuHost(options: KohakuHostOptions): KohakuHost;

export interface PrivateScanState {
  protocol: PrivacyProtocol;
  chainId: ChainId;
  account: Hex;
  applicationId?: string;
  scanScope?: string;
  fromBlock?: string;
  toBlock: string;
  latestMerkleRoot?: Hex;
  updatedAt?: number;
}

export interface PrivateScanStateStore {
  key(context: PrivacyContext, protocol: PrivacyProtocol): string;
  get(context: PrivacyContext, protocol: PrivacyProtocol): PrivateScanState | null;
  set(context: PrivacyContext, protocol: PrivacyProtocol, state: Partial<PrivateScanState> & { toBlock: bigint | string | number }): PrivateScanState;
  reset(context: PrivacyContext, protocol: PrivacyProtocol): void;
}

export function createPrivateScanStateStore(storage?: KohakuHost["storage"]): PrivateScanStateStore;

export interface PrivateScanLifecycle {
  readonly protocol: PrivacyProtocol;
  checkpoint(context: PrivacyContext, state: Partial<PrivateScanState> & { toBlock: bigint | string | number }): PrivateScanState;
  read(context: PrivacyContext): {
    status: "missing" | "fresh" | "stale";
    state: PrivateScanState | null;
    ageMs: number | null;
    staleAfterMs: number;
  };
  requireFresh(context: PrivacyContext): PrivateScanState;
  reset(context: PrivacyContext): void;
}

export function createPrivateScanLifecycle(options?: {
  protocol?: PrivacyProtocol;
  store?: PrivateScanStateStore;
  storage?: KohakuHost["storage"];
  staleAfterMs?: number;
  now?: () => number;
}): PrivateScanLifecycle;

export interface PrivateBalance {
  protocol: PrivacyProtocol;
  chainId: ChainId;
  asset: Hex;
  amount: bigint;
  verified: boolean;
  metadataBudget: MetadataBudget;
}

export interface PrivateScanner {
  readonly protocol: PrivacyProtocol;

  metadataBudget(context: PrivacyContext): Promise<MetadataBudget>;

  scanBalances(context: PrivacyContext): Promise<readonly PrivateBalance[]>;

  sync(context: PrivacyContext): Promise<{
    fromBlock?: bigint;
    toBlock: bigint;
    latestMerkleRoot?: Hex;
  }>;
}

export interface PrivateOperationRequest {
  context: PrivacyContext;
  asset?: Hex;
  amount?: bigint;
  recipient?: string;
  deadline?: bigint;
  maxFee?: bigint;
}

export interface BuiltPrivateOperation {
  protocol: PrivacyProtocol;
  chainId: ChainId;
  calls: readonly {
    target: Hex;
    value: bigint;
    data: Hex;
  }[];
  metadataBudget: MetadataBudget;
  operation: unknown;
  requiresVaultDelay: boolean;
  requiresBridgeFinality?: string;
}

export interface PrivateExecutionAdapter {
  readonly protocol: PrivacyProtocol;

  buildOperation(request: PrivateOperationRequest): Promise<BuiltPrivateOperation>;
}

export interface ShieldedPoolAdapter extends PrivateExecutionAdapter {
  createAccount(context: PrivacyContext): Promise<{
    shieldedAddress: string;
    metadataBudget: MetadataBudget;
  }>;

  shield(request: PrivateOperationRequest): Promise<BuiltPrivateOperation>;

  unshield(request: PrivateOperationRequest): Promise<BuiltPrivateOperation>;

  privateTransfer(request: PrivateOperationRequest): Promise<BuiltPrivateOperation>;

  broadcastPrivateOperation(context: PrivacyContext, operation: unknown): Promise<{
    protocol: PrivacyProtocol;
    chainId: ChainId;
    metadataBudget: MetadataBudget;
    result: unknown;
  }>;
}

export interface KohakuShieldedPoolPlugin {
  createAccount?(context: PrivacyContext, host: KohakuHost): Promise<{ shieldedAddress: string }>;
  prepareShield?(request: PrivateOperationRequest, host: KohakuHost): Promise<unknown>;
  prepareUnshield?(request: PrivateOperationRequest, host: KohakuHost): Promise<unknown>;
  prepareTransfer?(request: PrivateOperationRequest, host: KohakuHost): Promise<unknown>;
  broadcastPrivateOperation?(operation: unknown, host: KohakuHost): Promise<unknown>;
  instanceId?(): Promise<string>;
  balance?(assets?: readonly unknown[]): Promise<readonly unknown[]>;
  prepareShieldMulti?(assets: readonly unknown[], to?: string): Promise<unknown>;
  prepareTransferMulti?(assets: readonly unknown[], to: string): Promise<unknown>;
  prepareUnshieldMulti?(assets: readonly unknown[], to: Hex): Promise<unknown>;
  broadcast?(operation: unknown): Promise<unknown>;
}

export function createKohakuShieldedPoolAdapter(options: {
  protocol?: PrivacyProtocol;
  host: KohakuHost;
  plugin: KohakuShieldedPoolPlugin;
}): ShieldedPoolAdapter;

export interface RailgunAdapterProfile {
  readonly protocol: "railgun";
  readonly adapter: ShieldedPoolAdapter;
  readonly scanState: PrivateScanStateStore;
  metadataBudget(context: PrivacyContext): Promise<MetadataBudget>;
  createAccount: ShieldedPoolAdapter["createAccount"];
  shield: ShieldedPoolAdapter["shield"];
  privateTransfer: ShieldedPoolAdapter["privateTransfer"];
  unshield: ShieldedPoolAdapter["unshield"];
  broadcastPrivateOperation: ShieldedPoolAdapter["broadcastPrivateOperation"];
  balance(context: PrivacyContext, assets?: readonly unknown[]): Promise<readonly PrivateBalance[]>;
  sync(context: PrivacyContext, state?: unknown): Promise<PrivateScanState & { metadataBudget: MetadataBudget }>;
}

export function createRailgunAdapterProfile(options: {
  host: KohakuHost;
  config?: Record<string, unknown>;
  storage?: KohakuHost["storage"];
  createPlugin?: (host: KohakuHost, config: Record<string, unknown>) => Promise<KohakuShieldedPoolPlugin & {
    balance?: (assets?: readonly unknown[]) => Promise<readonly unknown[]>;
    sync?: (request: { context: PrivacyContext; state?: unknown }, host: KohakuHost) => Promise<{
      fromBlock?: bigint | string | number;
      toBlock: bigint | string | number;
      latestMerkleRoot?: Hex;
    }>;
  }>;
}): Promise<RailgunAdapterProfile>;

export interface RailgunRehearsalOperationInput extends PrivateOperationRequest {
  operationId?: string;
  permissionHash: Hex;
  expiry: number;
  maxFeeBound: boolean;
  receiptStatus: "success";
  metadataBudgetHash?: Hex;
  broadcast?: boolean;
}

export interface RailgunRehearsalOptions {
  confirmLiveNetwork: true;
  mockProtocol?: false;
  providerProfile: KohakuProviderProfile;
  providerConsentConfirmed: true;
  context: PrivacyContext;
  dependency: {
    version: string;
    auditReviewed: boolean;
    licenseReviewed: boolean;
    lockfilePinned: boolean;
    reviewReference: string;
  };
  provider: {
    mode: "user-rpc" | "local-node" | "helios" | "colibri" | "custom";
    defaultEndpoint: false;
    requiresConsent: boolean;
    verifiedReads?: boolean;
    degradedModeDocumented?: boolean;
  };
  metadata: {
    requiredSurfaces: readonly MetadataSurface[];
    disclosesViewingKey: false;
    disclosesAccountGraph: false;
    telemetryDisabled: boolean;
    budgetTestsPassed: boolean;
  };
  scan: {
    localFirst: boolean;
    incrementalCheckpoints: boolean;
    scopedByApplication: boolean;
    staleStatePolicy: "fail-closed";
    reindexFromGenesisOnStartup: false;
    initial?: Partial<PrivateScanState> & { toBlock?: bigint | string | number };
    final?: Partial<PrivateScanState> & { toBlock?: bigint | string | number };
  };
  operations: {
    shield: RailgunRehearsalOperationInput;
    privateTransfer: RailgunRehearsalOperationInput;
    unshield: RailgunRehearsalOperationInput;
    vaultProtectedUnshield: {
      privateOperationHash: Hex;
      vaultIntentHash: Hex;
      scheduleTxHash: Hex;
      executeTxHash: Hex;
      delaySeconds: number;
    };
  };
  operationPolicy: {
    shield: {
      enabled: boolean;
      permissionBound: boolean;
      maxFeeBound: boolean;
      expiryBound: boolean;
    };
    privateTransfer: {
      enabled: boolean;
      permissionBound: boolean;
      maxFeeBound: boolean;
      expiryBound: boolean;
    };
    unshield: {
      enabled: boolean;
      permissionBound: boolean;
      maxFeeBound: boolean;
      expiryBound: boolean;
      vaultDelayForProtectedAssets: boolean;
      bridgeFinalityDocumented?: boolean;
    };
  };
  failureProbes?: Record<string, (() => Promise<void>) | {
    tested: boolean;
    classified: boolean;
  }>;
  services: {
    indexer: {
      kind: "community" | "self-hosted" | "protocol" | "third-party";
      mandatory: false;
      origin: string;
      failureModeTested: boolean;
      failureClassified: boolean;
    };
    relayer: {
      kind: "community" | "self-hosted" | "protocol" | "third-party";
      mandatory: false;
      origin: string;
      failureModeTested: boolean;
      failureClassified: boolean;
    };
    prover: {
      kind: "community" | "self-hosted" | "protocol" | "third-party";
      mandatory: false;
      origin: string;
      failureModeTested: boolean;
      failureClassified: boolean;
    };
  };
  network: {
    environment: "testnet" | "mainnet";
    name: string;
  };
  checks: Record<string, boolean>;
  sdkReference?: string;
  railgunConfig?: Record<string, unknown>;
  assets?: readonly unknown[];
  metadataPolicy?: MetadataPolicy;
  storage?: KohakuHost["storage"];
  keystore?: KohakuHost["keystore"];
  consentStore?: ConsentStore;
  fetch?: typeof fetch;
  host?: KohakuHost;
  now?: () => number;
  createPlugin?: (host: KohakuHost, config: Record<string, unknown>) => Promise<KohakuShieldedPoolPlugin & {
    balance?: (assets?: readonly unknown[]) => Promise<readonly unknown[]>;
  }>;
}

export function runRailgunLiveRehearsal(options: RailgunRehearsalOptions): Promise<Record<string, unknown>>;

export interface PrivacyPoolsAdapterProfile {
  readonly protocol: "privacy-pool";
  readonly adapter: ShieldedPoolAdapter;
  readonly scanState: PrivateScanStateStore;
  metadataBudget(context: PrivacyContext): Promise<MetadataBudget>;
  createAccount: ShieldedPoolAdapter["createAccount"];
  shield: ShieldedPoolAdapter["shield"];
  privateTransfer: ShieldedPoolAdapter["privateTransfer"];
  unshield: ShieldedPoolAdapter["unshield"];
  broadcastPrivateOperation: ShieldedPoolAdapter["broadcastPrivateOperation"];
  sync(context: PrivacyContext, state?: unknown): Promise<PrivateScanState & { metadataBudget: MetadataBudget }>;
}

export function createPrivacyPoolsAdapterProfile(options: {
  host: KohakuHost;
  config?: Record<string, unknown>;
  storage?: KohakuHost["storage"];
  createPlugin?: (host: KohakuHost, config: Record<string, unknown>) => Promise<KohakuShieldedPoolPlugin & {
    sync?: (request: { context: PrivacyContext; state?: unknown }, host: KohakuHost) => Promise<{
      fromBlock?: bigint | string | number;
      toBlock: bigint | string | number;
      latestMerkleRoot?: Hex;
    }>;
  }>;
}): Promise<PrivacyPoolsAdapterProfile>;

export interface AztecAdapterProfile {
  readonly protocol: "aztec";
  readonly adapter: ShieldedPoolAdapter;
  readonly scanState: PrivateScanStateStore;
  metadataBudget(context: PrivacyContext): Promise<MetadataBudget>;
  createAccount: ShieldedPoolAdapter["createAccount"];
  shield: ShieldedPoolAdapter["shield"];
  privateTransfer: ShieldedPoolAdapter["privateTransfer"];
  unshield: ShieldedPoolAdapter["unshield"];
  broadcastPrivateOperation: ShieldedPoolAdapter["broadcastPrivateOperation"];
  sync(context: PrivacyContext, state?: unknown): Promise<PrivateScanState & { metadataBudget: MetadataBudget }>;
}

export function createAztecAdapterProfile(options: {
  host: KohakuHost;
  config?: Record<string, unknown>;
  storage?: KohakuHost["storage"];
  createPlugin?: (host: KohakuHost, config: Record<string, unknown>) => Promise<KohakuShieldedPoolPlugin & {
    sync?: (request: { context: PrivacyContext; state?: unknown }, host: KohakuHost) => Promise<{
      fromBlock?: bigint | string | number;
      toBlock: bigint | string | number;
      latestMerkleRoot?: Hex;
    }>;
  }>;
}): Promise<AztecAdapterProfile>;

export interface StealthReceiveAdapter {
  readonly protocol: PrivacyProtocol;

  deriveReceiveTarget(context: PrivacyContext, label?: string): Promise<{
    address: string;
    metadataBudget: MetadataBudget;
  }>;
}

export interface ViewingKeyStore {
  listScopes(): Promise<readonly string[]>;

  exportWarning(scope: string): Promise<string>;
}

export interface KohakuAccountSecurityProfile {
  upstream: "ethereum/kohaku";
  path: "packages/pq-account";
  revision: string;
  status: "source-tracked" | "reviewed" | "supported";
  verification: "hybrid-ecdsa-and-post-quantum";
  productionGate: string;
}

// Canonical home of the private-flow wallet surface (the same names on
// @loom/sdk are deprecated; import them from here).
export {
  createKohakuRuntime,
  preparePrivateVaultWithdrawal
} from "@loom/sdk";
// KohakuHost is already declared by this package (privacy owns the host
// contract); the engine-side runtime and preparation types re-export here.
export type {
  KohakuRuntime,
  PrivateVaultWithdrawalPreparation,
  PrivateVaultWithdrawalPreparationInput
} from "@loom/sdk";
