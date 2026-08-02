export type AppErrorCode =
  | "PASSKEY_UNSUPPORTED"
  | "PASSKEY_CANCELLED"
  | "PASSKEY_FAILED"
  | "INVALID_INPUT"
  | "CHAIN_MISMATCH"
  | "RPC_UNAVAILABLE"
  | "BUNDLER_UNAVAILABLE"
  | "USER_OPERATION_REJECTED"
  | "USER_OPERATION_TIMEOUT"
  | "TRANSACTION_REVERTED"
  | "INVALID_LOCAL_DATA"
  | "CONFIGURATION_ERROR"
  | "OPERATION_IN_PROGRESS"
  | "UNKNOWN";

export type OperationStage =
  | "validation"
  | "preparation"
  | "estimation"
  | "passkey"
  | "submission"
  | "confirmation"
  | "storage"
  | "configuration";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly diagnostic: string;
  readonly retryable: boolean;
  readonly stage: OperationStage;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;

  constructor(input: {
    code: AppErrorCode;
    userMessage: string;
    diagnostic?: string;
    retryable: boolean;
    stage: OperationStage;
    cause?: unknown;
    metadata?: Record<string, string | number | boolean>;
  }) {
    super(input.userMessage, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "AppError";
    this.code = input.code;
    this.userMessage = input.userMessage;
    this.diagnostic = input.diagnostic ?? input.userMessage;
    this.retryable = input.retryable;
    this.stage = input.stage;
    this.metadata = Object.freeze({ ...(input.metadata ?? {}) });
  }
}

export function normalizeAppError(issue: unknown, stage: OperationStage): AppError {
  if (issue instanceof AppError) return issue;
  if (isDomException(issue, "NotAllowedError")) {
    return new AppError({
      code: "PASSKEY_CANCELLED",
      userMessage: "Passkey confirmation was cancelled or timed out.",
      diagnostic: safeDiagnostic(issue),
      retryable: true,
      stage: "passkey",
      cause: issue
    });
  }
  if (isDomException(issue, "InvalidStateError")) {
    return new AppError({
      code: "PASSKEY_FAILED",
      userMessage: "This passkey is already registered on this authenticator.",
      diagnostic: safeDiagnostic(issue),
      retryable: false,
      stage: "passkey",
      cause: issue
    });
  }
  const bundlerError = normalizeBundlerRpcError(issue, stage);
  if (bundlerError) return bundlerError;
  const diagnostic = safeDiagnostic(issue);
  const lower = diagnostic.toLowerCase();
  if (stage === "validation") {
    return new AppError({ code: "INVALID_INPUT", userMessage: "Check the entered values and try again.", diagnostic, retryable: true, stage, cause: issue });
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new AppError({ code: "USER_OPERATION_TIMEOUT", userMessage: "Confirmation took too long. Check the operation status before retrying.", diagnostic, retryable: true, stage, cause: issue });
  }
  if (lower.includes("chain") && (lower.includes("mismatch") || lower.includes("switch"))) {
    return new AppError({ code: "CHAIN_MISMATCH", userMessage: "The selected network does not match this wallet.", diagnostic, retryable: true, stage, cause: issue });
  }
  return new AppError({
    code: "UNKNOWN",
    userMessage: "The operation could not be completed. Try again or open diagnostics for details.",
    diagnostic,
    retryable: true,
    stage,
    cause: issue
  });
}

export function safeUserMessage(issue: unknown, fallback: string, stage: OperationStage): string {
  if (issue instanceof AppError) return issue.userMessage;
  const normalized = normalizeAppError(issue, stage);
  return normalized.code === "PASSKEY_CANCELLED" || normalized.code === "PASSKEY_FAILED"
    ? normalized.userMessage
    : fallback;
}

function isDomException(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

function safeDiagnostic(issue: unknown): string {
  if (!(issue instanceof Error)) return "Unknown error";
  const message = redactEndpoints(issue.message);
  return `${issue.name}: ${message}`.slice(0, 1_000);
}

function normalizeBundlerRpcError(issue: unknown, stage: OperationStage): AppError | undefined {
  if (!(issue instanceof Error) || issue.name !== "InvalidSdkRequestError" || issue.message !== "bundler rpc request failed") return undefined;
  const details = "details" in issue && issue.details && typeof issue.details === "object"
    ? issue.details as Record<string, unknown>
    : {};
  const method = typeof details.method === "string" ? details.method : "unknown";
  const code = typeof details.code === "string" || typeof details.code === "number" ? String(details.code) : "unknown";
  const message = typeof details.message === "string" ? redactEndpoints(details.message) : "No safe bundler message was provided.";
  const operationRejected = method === "eth_estimateUserOperationGas" || method === "eth_sendUserOperation";
  return new AppError({
    code: operationRejected ? "USER_OPERATION_REJECTED" : "BUNDLER_UNAVAILABLE",
    userMessage: method === "eth_estimateUserOperationGas"
      ? "The bundler rejected gas estimation for this wallet operation."
      : method === "eth_sendUserOperation"
        ? "The bundler rejected the signed wallet operation."
        : "The bundler could not complete this request.",
    diagnostic: `InvalidSdkRequestError: method=${method}; code=${code}; message=${message}`.slice(0, 1_000),
    retryable: true,
    stage,
    cause: issue,
    metadata: { method, code }
  });
}

function redactEndpoints(value: string): string {
  return value.replace(/https?:\/\/[^\s)]+/gu, "[endpoint redacted]");
}
