import type {
  BeginEventInput,
  FinishEventInput,
  JsonValue,
  LabEnvironmentManifest,
  LabEvent,
  LabRunStatus,
  SemanticStateValue,
  WalletLabArtifact,
  WalletLabScenario
} from "./model.js";

const SECRET_KEY = /(?:private|secret|mnemonic|authorization|cookie|storage.?state|credential.?private|password|api.?key|access.?token|refresh.?token)/i;
const ENDPOINT_KEY = /(?:endpoint|rpcUrl|bundlerUrl)$/i;

function endpointOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "[redacted-endpoint]";
  }
}

function redactEmbeddedEndpoints(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/giu, endpoint => endpointOrigin(endpoint));
}

function sanitize(value: unknown, key = "", removed = new Set<string>()): JsonValue {
  if (SECRET_KEY.test(key)) {
    removed.add(key);
    return "[redacted]";
  }
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string" && ENDPOINT_KEY.test(key)) return endpointOrigin(value);
    return typeof value === "string" ? redactEmbeddedEndpoints(value) : value;
  }
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(item => sanitize(item, key, removed));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey, removed)
      ])
    );
  }
  return String(value);
}

export interface TraceRecorderOptions {
  readonly runId: string;
  readonly traceId: string;
  readonly scenario: WalletLabScenario;
  readonly now?: () => number;
  readonly onChange?: (artifact: WalletLabArtifact) => void;
}

export function createTraceRecorder(options: TraceRecorderOptions) {
  const now = options.now ?? Date.now;
  const startedMs = now();
  const removedFields = new Set<string>();
  let sequence = 0;
  let status: LabRunStatus = "running";
  let finishedAt: string | undefined;
  let environment: LabEnvironmentManifest | undefined;
  let stateDiff: readonly SemanticStateValue[] = [];
  let invariants: WalletLabArtifact["invariants"] = options.scenario.expectedInvariants.map(id => ({
    id,
    status: "not-run",
    explanation: "The invariant has not been evaluated yet."
  }));
  let firstFailingBoundary: WalletLabArtifact["firstFailingBoundary"];
  const events: LabEvent[] = [];
  const started = new Map<string, number>();

  function snapshot(): WalletLabArtifact {
    const artifact: WalletLabArtifact = {
      schema: "loom.wallet-lab.run",
      version: 1,
      runId: options.runId,
      scenarioId: options.scenario.id,
      scenario: sanitize(options.scenario, "scenario", removedFields) as unknown as WalletLabScenario,
      traceId: options.traceId,
      status,
      startedAt: new Date(startedMs).toISOString(),
      ...(finishedAt ? { finishedAt } : {}),
      ...(firstFailingBoundary ? { firstFailingBoundary } : {}),
      ...(environment ? { environment } : {}),
      events: events.map(event => Object.freeze({ ...event })),
      stateDiff,
      invariants,
      replay: {
        command: "npm run wallet-lab:replay -- .loom/wallet-lab/latest-run.json",
        scenarioVersion: options.scenario.version,
        seed: options.scenario.seed
      },
      redaction: {
        level: removedFields.size > 0 ? "redacted" : "public-test-only",
        removedFields: [...removedFields].sort()
      }
    };
    return Object.freeze(artifact);
  }

  function changed(): void {
    options.onChange?.(snapshot());
  }

  function begin(input: BeginEventInput): string {
    sequence += 1;
    const spanId = sequence.toString(16).padStart(16, "0");
    const timestampMs = now();
    started.set(spanId, timestampMs);
    events.push({
      runId: options.runId,
      scenarioId: options.scenario.id,
      traceId: options.traceId,
      spanId,
      ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
      timestamp: new Date(timestampMs).toISOString(),
      monotonicSequence: sequence,
      component: input.component,
      phase: input.phase,
      status: input.status ?? "running",
      redactionLevel: "public-test-only",
      ...(input.source ? { source: input.source } : {}),
      explanation: input.explanation,
      ...(input.reproduction ? { reproduction: input.reproduction } : {}),
      payload: sanitize(input.payload ?? {}, "payload", removedFields)
    });
    changed();
    return spanId;
  }

  function finish(spanId: string, input: FinishEventInput): void {
    const index = events.findIndex(event => event.spanId === spanId);
    if (index < 0) throw new Error(`unknown wallet lab span: ${spanId}`);
    const event = events[index];
    if (!event) throw new Error(`missing wallet lab event: ${spanId}`);
    const finishedMs = now();
    const next: LabEvent = {
      ...event,
      status: input.status,
      durationMs: Math.max(0, finishedMs - (started.get(spanId) ?? finishedMs)),
      explanation: input.explanation ?? event.explanation,
      payload: sanitize(input.payload ?? event.payload, "payload", removedFields),
      ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
      ...(input.account ? { account: input.account } : {}),
      ...(input.entryPoint ? { entryPoint: input.entryPoint } : {}),
      ...(input.bundler ? { bundler: endpointOrigin(input.bundler) } : {}),
      ...(input.userOpHash ? { userOpHash: input.userOpHash } : {}),
      ...(input.transactionHash ? { transactionHash: input.transactionHash } : {}),
      ...(input.blockHash ? { blockHash: input.blockHash } : {}),
      ...(input.blockNumber !== undefined ? { blockNumber: input.blockNumber } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorSource ? { errorSource: input.errorSource } : {})
    };
    events[index] = next;
    started.delete(spanId);
    if (input.status === "error" || input.status === "reverted") firstFailingBoundary ??= event.component;
    changed();
  }

  return Object.freeze({
    begin,
    finish,
    fail(error: unknown) {
      const candidate = [...events].reverse().find(event => event.status === "running"
        || event.status === "waiting-user"
        || event.status === "waiting-guardian"
        || event.status === "waiting-bundler"
        || event.status === "pending-chain");
      const normalized = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack ?? "" }
        : { name: "UnknownError", message: String(error), stack: "" };
      if (candidate) {
        finish(candidate.spanId, {
          status: "error",
          explanation: `The ${candidate.component} boundary failed before the lifecycle could advance.`,
          payload: { ...(candidate.payload as object), error: normalized },
          errorCode: normalized.name,
          errorSource: candidate.component
        });
      } else {
        const spanId = begin({
          component: "orchestrator",
          phase: "environment",
          explanation: "The laboratory run failed outside a currently active lifecycle boundary.",
          payload: { error: normalized }
        });
        finish(spanId, {
          status: "error",
          errorCode: normalized.name,
          errorSource: "orchestrator"
        });
      }
    },
    setEnvironment(value: LabEnvironmentManifest) {
      environment = sanitize(value, "environment", removedFields) as unknown as LabEnvironmentManifest;
      changed();
    },
    setStateDiff(value: readonly SemanticStateValue[]) {
      stateDiff = sanitize(value, "stateDiff", removedFields) as unknown as readonly SemanticStateValue[];
      changed();
    },
    setInvariant(id: string, invariantStatus: "pass" | "fail", explanation: string) {
      if (!invariants.some(invariant => invariant.id === id)) throw new Error(`unknown wallet lab invariant: ${id}`);
      invariants = invariants.map(invariant => invariant.id === id ? { id, status: invariantStatus, explanation } : invariant);
      if (invariantStatus === "fail") status = "error";
      changed();
    },
    complete(finalStatus: LabRunStatus) {
      status = finalStatus;
      finishedAt = new Date(now()).toISOString();
      changed();
      return snapshot();
    },
    snapshot
  });
}

export function assertWalletLabArtifact(value: unknown): asserts value is WalletLabArtifact {
  if (!value || typeof value !== "object") throw new Error("wallet lab artifact must be an object");
  const artifact = value as Partial<WalletLabArtifact>;
  if (artifact.schema !== "loom.wallet-lab.run" || artifact.version !== 1) {
    throw new Error("unsupported wallet lab artifact schema");
  }
  if (!artifact.scenario || artifact.scenario.id !== artifact.scenarioId
    || artifact.scenario.version !== artifact.replay?.scenarioVersion
    || artifact.scenario.seed !== artifact.replay?.seed) {
    throw new Error("wallet lab scenario identity does not match replay metadata");
  }
  if (!Array.isArray(artifact.events) || !Array.isArray(artifact.stateDiff)) {
    throw new Error("wallet lab artifact collections are invalid");
  }
  let previous = 0;
  for (const event of artifact.events) {
    if (event.runId !== artifact.runId || event.scenarioId !== artifact.scenarioId || event.traceId !== artifact.traceId) {
      throw new Error("wallet lab event correlation identifiers do not match the run");
    }
    if (event.monotonicSequence <= previous) throw new Error("wallet lab event sequence is not monotonic");
    previous = event.monotonicSequence;
  }
}
