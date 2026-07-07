import type { MetadataBudget, PrivacyContext, RailgunAdapterProfile } from "@loom/privacy";
import type {
  AccountSafetyState,
  LoomClient,
  LoomStateReadTransport,
  LoomTransportAdapter
} from "@loom/sdk";

export type Hex = `0x${string}`;

export type WalletEnvironment = "development" | "testnet" | "production";

export type ReleaseGateStatus = "passed" | "blocked" | "not-configured";

export interface ReleaseGate {
  readonly id: string;
  readonly title: string;
  readonly status: ReleaseGateStatus;
  readonly summary: string;
  readonly evidence?: string;
}

export interface PlatformPasskeyRegistration {
  readonly publicKeyX: Hex;
  readonly publicKeyY: Hex;
  readonly credentialIdHash: Hex;
  readonly rpId: string;
  readonly origin: string;
}

export interface PlatformPasskeyAssertion {
  readonly authenticatorData: Hex;
  readonly clientDataJSON: Hex;
  readonly signature: Hex;
  readonly userHandle?: Hex;
}

export interface PlatformPasskeyAuthenticator {
  isPlatformPasskeyAvailable(): Promise<boolean>;
  createPasskey(input: {
    readonly rpId: string;
    readonly challenge: Hex;
    readonly userName: string;
    readonly displayName: string;
  }): Promise<PlatformPasskeyRegistration>;
  signWithPasskey(input: {
    readonly rpId: string;
    readonly challenge: Hex;
    readonly credentialIdHash: Hex;
  }): Promise<PlatformPasskeyAssertion>;
}

export interface NetworkConfiguration {
  readonly chainId: number;
  readonly l1ChainId: number;
  readonly rpcUrl?: string;
  readonly bundlerUrl?: string;
  readonly entryPoint?: Hex;
}

export interface DeploymentConfiguration {
  readonly accountFactory?: Hex;
  readonly passkeyValidator?: Hex;
  readonly deploymentManifestPath?: string;
}

export interface PrivacyConfiguration {
  readonly railgunProfile?: RailgunAdapterProfile;
  readonly context?: PrivacyContext;
  readonly releaseGate: ReleaseGate;
}

export interface MobileWalletConfiguration {
  readonly environment: WalletEnvironment;
  readonly rpId: string;
  readonly origin: string;
  readonly network: NetworkConfiguration;
  readonly deployment: DeploymentConfiguration;
  readonly privacy: PrivacyConfiguration;
  readonly transport?: LoomTransportAdapter;
  readonly stateTransport?: LoomStateReadTransport;
}

export interface WalletRuntime {
  readonly config: MobileWalletConfiguration;
  readonly passkey: PlatformPasskeyAuthenticator;
  readonly client?: LoomClient;
}

export type FlowResult<T> =
  | {
      readonly status: "ready";
      readonly value: T;
      readonly gates?: readonly ReleaseGate[];
    }
  | {
      readonly status: "blocked";
      readonly gates: readonly ReleaseGate[];
    };

export interface AccountCreationReadiness {
  readonly registration: PlatformPasskeyRegistration;
  readonly recoveryStatus: "unprotected-recovery" | "guardian-protected";
  readonly accountSafety?: AccountSafetyState;
}

export interface SessionPermissionDraft {
  readonly sessionKey: Hex;
  readonly target: Hex;
  readonly selector: Hex;
  readonly token: Hex;
  readonly maxAmount: bigint;
  readonly validUntil: bigint;
  readonly maxUses: number;
}

export interface PrivateSendDraft {
  readonly asset: Hex;
  readonly amount: bigint;
  readonly recipient: string;
  readonly maxFee: bigint;
  readonly deadline: bigint;
  readonly metadataBudget?: MetadataBudget;
}

