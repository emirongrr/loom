/**
 * Stable Loom error codes. A code identifies the layer and failure class so a
 * caller can branch on it without parsing a message. The list is append-only:
 * codes are never repurposed once published.
 */
export type LoomErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_UNKNOWN_FIELD"
  | "CHAIN_MISMATCH"
  | "MANIFEST_INVALID"
  | "MANIFEST_CODE_HASH_MISMATCH"
  | "ENTRYPOINT_UNSUPPORTED"
  | "ACCOUNT_UNDEPLOYED"
  | "ACCOUNT_EXECUTION_REVERTED"
  | "SIGNATURE_INVALID"
  | "WEBAUTHN_INVALID"
  | "PASSKEY_PLATFORM_UNSUPPORTED"
  | "BUNDLER_REJECTED"
  | "BUNDLER_UNSUPPORTED_ENTRYPOINT"
  | "GAS_ESTIMATION_FAILED"
  | "PAYMASTER_REJECTED"
  | "RPC_INCONSISTENT"
  | "TRANSPORT_FAILED"
  | "TIMEOUT"
  | "MODULE_INCOMPATIBLE"
  | "VALIDATOR_INVALID"
  | "SESSION_INVALID"
  | "RECOVERY_INVALID"
  | "MIGRATION_INVALID"
  | "PRIVACY_CONSENT_REQUIRED"
  | "PRIVACY_SYNC_FAILED"
  | "PRIVACY_METADATA_EXCEEDED";

export interface LoomErrorOptions {
  /**
   * A message safe to surface to an end user or log sink. It must never carry
   * endpoint credentials, headers, passkey material, guardian secrets, viewing
   * keys, or signing material. Defaults to the developer message.
   */
  readonly safeMessage?: string;
  /** Structured, developer-facing context. Frozen on construction. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Whether retrying the same operation may succeed. */
  readonly retryable?: boolean;
  /** A short, actionable hint for resolving the failure. */
  readonly remediation?: string;
  /** The underlying error, preserved for diagnostics. */
  readonly cause?: unknown;
}

/**
 * The single error type raised across Loom packages. Every failure maps to a
 * stable {@link LoomErrorCode}; the developer `message` may be detailed while
 * `safeMessage` stays free of secrets.
 */
export class LoomError extends Error {
  readonly code: LoomErrorCode;
  readonly safeMessage: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly remediation?: string;

  constructor(code: LoomErrorCode, message: string, options: LoomErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LoomError";
    this.code = code;
    this.safeMessage = options.safeMessage ?? message;
    this.details = Object.freeze({ ...options.details });
    this.retryable = options.retryable ?? false;
    if (options.remediation !== undefined) this.remediation = options.remediation;
  }
}

/** Narrow an unknown value to a {@link LoomError}. */
export function isLoomError(value: unknown): value is LoomError {
  return value instanceof LoomError;
}
