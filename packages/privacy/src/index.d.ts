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
  requireKnownMitigation?: boolean;
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
  };
  keystore: {
    deriveAt(path: string): Hex;
  };
  provider: {
    profile: KohakuProviderProfile;
    request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
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

export function providerConsentKey(profile: KohakuProviderProfile): string;

export function createConsentStore(initialKeys?: readonly string[]): ConsentStore;

export function createMemoryStorage(initial?: Record<string, string>): KohakuHost["storage"];

export function createMetadataBudget(input: MetadataBudget): MetadataBudget;

export function createProviderProfile(input: KohakuProviderProfile): KohakuProviderProfile;

export function assertMetadataBudgetAllowed(budget: MetadataBudget, policy?: MetadataPolicy): void;

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
}

export interface PrivateScanStateStore {
  key(context: PrivacyContext, protocol: PrivacyProtocol): string;
  get(context: PrivacyContext, protocol: PrivacyProtocol): PrivateScanState | null;
  set(context: PrivacyContext, protocol: PrivacyProtocol, state: Partial<PrivateScanState> & { toBlock: bigint | string | number }): PrivateScanState;
}

export function createPrivateScanStateStore(storage?: KohakuHost["storage"]): PrivateScanStateStore;

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
