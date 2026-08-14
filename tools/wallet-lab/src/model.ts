export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type LabRunStatus = "running" | "success" | "error";
export type LabEventStatus =
  | "not-started"
  | "running"
  | "waiting-user"
  | "waiting-guardian"
  | "waiting-bundler"
  | "pending-chain"
  | "included"
  | "confirmed"
  | "finalized"
  | "success"
  | "reverted"
  | "dropped"
  | "replaced"
  | "reorganized"
  | "simulated"
  | "error";

export type LabComponent =
  | "orchestrator"
  | "wallet-ui"
  | "sdk"
  | "webauthn"
  | "rpc"
  | "bundler"
  | "entry-point"
  | "account"
  | "validator"
  | "hook"
  | "target"
  | "tracker";

export type LabPhase =
  | "environment"
  | "intent"
  | "account-resolution"
  | "manifest-verification"
  | "state-before"
  | "call-construction"
  | "userop-preparation"
  | "gas-estimation"
  | "webauthn"
  | "signing"
  | "bundler-submission"
  | "bundler-validation"
  | "inclusion"
  | "entrypoint-validation"
  | "execution"
  | "receipt"
  | "network"
  | "state-after"
  | "finality"
  | "ui";

export interface LabSourceLocation {
  readonly file: string;
  readonly line?: number;
  readonly symbol?: string;
}

export interface LabEvent {
  readonly runId: string;
  readonly scenarioId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly timestamp: string;
  readonly monotonicSequence: number;
  readonly chainId?: number;
  readonly account?: string;
  readonly entryPoint?: string;
  readonly bundler?: string;
  readonly userOpHash?: string;
  readonly transactionHash?: string;
  readonly blockHash?: string;
  readonly blockNumber?: number;
  readonly component: LabComponent;
  readonly phase: LabPhase;
  readonly status: LabEventStatus;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly errorSource?: string;
  readonly redactionLevel: "public-test-only" | "redacted";
  readonly source?: LabSourceLocation;
  readonly explanation: string;
  readonly reproduction?: string;
  readonly payload: JsonValue;
}

export interface LabComponentVersion {
  readonly name: string;
  readonly version: string;
  readonly digest?: string;
  readonly endpoint?: string;
  readonly status: "healthy" | "unhealthy" | "stopped" | "unknown";
}

export interface LabEnvironmentManifest {
  readonly gitCommit: string;
  readonly dirty: boolean;
  readonly chainId: number;
  readonly seed: string;
  readonly snapshotId?: string;
  readonly addresses: Readonly<Record<string, string>>;
  readonly codeHashes: Readonly<Record<string, string>>;
  readonly components: readonly LabComponentVersion[];
}

export interface SemanticStateValue {
  readonly name: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
  readonly unit?: string;
  readonly explanation: string;
}

export interface WalletLabArtifact {
  readonly schema: "loom.wallet-lab.run";
  readonly version: 1;
  readonly runId: string;
  readonly scenarioId: string;
  readonly scenario: WalletLabScenario;
  readonly traceId: string;
  readonly status: LabRunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly firstFailingBoundary?: LabComponent;
  readonly environment?: LabEnvironmentManifest;
  readonly events: readonly LabEvent[];
  readonly stateDiff: readonly SemanticStateValue[];
  readonly invariants: readonly {
    readonly id: string;
    readonly status: "pass" | "fail" | "not-run";
    readonly explanation: string;
  }[];
  readonly replay: {
    readonly command: string;
    readonly scenarioVersion: number;
    readonly seed: string;
  };
  readonly redaction: {
    readonly level: "public-test-only" | "redacted";
    readonly removedFields: readonly string[];
  };
}

export interface NativeTransferAction {
  readonly id: string;
  readonly kind: "native-transfer";
  readonly target: "devnet-target";
  readonly valueWei: string;
  readonly targetCall: {
    readonly function: "setValue";
    readonly value: string;
  };
}

export interface WalletLabScenario {
  readonly schema: "loom.wallet-lab.scenario";
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly seed: string;
  readonly initialSnapshot: "clean-devnet";
  readonly actions: readonly NativeTransferAction[];
  readonly expectedInvariants: readonly string[];
}

export interface BeginEventInput {
  readonly component: LabComponent;
  readonly phase: LabPhase;
  readonly status?: LabEventStatus;
  readonly explanation: string;
  readonly payload?: unknown;
  readonly parentSpanId?: string;
  readonly source?: LabSourceLocation;
  readonly reproduction?: string;
}

export interface FinishEventInput {
  readonly status: LabEventStatus;
  readonly explanation?: string;
  readonly payload?: unknown;
  readonly chainId?: number;
  readonly account?: string;
  readonly entryPoint?: string;
  readonly bundler?: string;
  readonly userOpHash?: string;
  readonly transactionHash?: string;
  readonly blockHash?: string;
  readonly blockNumber?: number;
  readonly errorCode?: string;
  readonly errorSource?: string;
}
