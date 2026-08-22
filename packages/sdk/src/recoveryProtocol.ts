import type { Address, Hex } from "@loom/core";
import { getAddress, isAddress, keccak256, stringToHex } from "viem";
import { GuardianRecoveryError } from "./recovery.js";

const REQUEST_FIELDS = [
  "format", "version", "critical", "requestId", "chainId", "account", "recoveryManager",
  "guardianRoot", "guardianThreshold", "configVersion", "nonce", "newValidator", "initDataHash",
  "newGuardianRoot", "newGuardianThreshold", "createdAt", "expiresAt", "humanCode", "integrity"
] as const;
const REQUEST_CRITICAL = [
  "requestId", "chainId", "account", "recoveryManager", "guardianRoot", "guardianThreshold",
  "configVersion", "nonce", "newValidator", "initDataHash", "newGuardianRoot", "newGuardianThreshold", "expiresAt"
] as const;
const RESPONSE_FIELDS = [
  "format", "version", "critical", "requestId", "chainId", "account", "recoveryDigest", "guardianLeaf",
  "verifier", "keyCommitment", "salt", "proof", "signature", "signedAt", "expiresAt", "integrity"
] as const;
const RESPONSE_CRITICAL = [
  "requestId", "chainId", "account", "recoveryDigest", "guardianLeaf", "verifier", "keyCommitment",
  "salt", "proof", "signature", "expiresAt"
] as const;
const SIGNATURE_FIELDS = [
  "format", "version", "critical", "requestId", "chainId", "account", "recoveryDigest", "signature",
  "signedAt", "expiresAt", "integrity"
] as const;
const SIGNATURE_CRITICAL = [
  "requestId", "chainId", "account", "recoveryDigest", "signature", "expiresAt"
] as const;

/**
 * A guardian's signature over a recovery, and nothing else.
 *
 * The full response carries `guardianLeaf`, `verifier`, `keyCommitment`,
 * `salt` and `proof`, all of which come from a capability the guardian was
 * invited with. Requiring them made an invitation a precondition for helping,
 * so a guardian who had never been sent one -- or whose wallet had been reset
 * -- could not act at all, at the one moment they were needed.
 *
 * None of those five are secrets and none of them are the guardian's to know:
 * they describe membership of a set the *recovering* party holds. Only the
 * signature is the guardian's, and only the signature authorises anything. So
 * this carries only that, and the recovering side rebuilds the rest from its
 * own roster.
 *
 * A signature from someone who is not in the set matches no leaf and is worth
 * exactly nothing -- there is no state to poison and nothing to refuse, which
 * is why this can be accepted from anyone.
 */
export interface RecoverySignatureV1 {
  readonly format: "loom.recovery-signature";
  readonly version: 1;
  readonly critical: readonly string[];
  readonly requestId: Hex;
  readonly chainId: number;
  readonly account: Address;
  /** Repeated so a signer's own view of what they signed is checkable. */
  readonly recoveryDigest: Hex;
  readonly signature: Hex;
  readonly signedAt: number;
  readonly expiresAt: number;
  readonly integrity: ProtocolIntegrity;
}

export interface ProtocolIntegrity {
  readonly algorithm: "keccak256-canonical-json";
  readonly digest: Hex;
}

export interface RecoveryRequestV1 {
  readonly format: "loom.recovery-request";
  readonly version: 1;
  readonly critical: readonly string[];
  readonly requestId: Hex;
  readonly chainId: number;
  readonly account: Address;
  readonly recoveryManager: Address;
  readonly guardianRoot: Hex;
  readonly guardianThreshold: number;
  readonly configVersion: string;
  readonly nonce: string;
  readonly newValidator: Address;
  readonly initDataHash: Hex;
  readonly newGuardianRoot: Hex;
  readonly newGuardianThreshold: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly humanCode: string;
  readonly integrity: ProtocolIntegrity;
}

export interface RecoveryResponseV1 {
  readonly format: "loom.recovery-response";
  readonly version: 1;
  readonly critical: readonly string[];
  readonly requestId: Hex;
  readonly chainId: number;
  readonly account: Address;
  readonly recoveryDigest: Hex;
  readonly guardianLeaf: Hex;
  readonly verifier: Address;
  readonly keyCommitment: Hex;
  readonly salt: Hex;
  readonly proof: readonly Hex[];
  readonly signature: Hex;
  readonly signedAt: number;
  readonly expiresAt: number;
  readonly integrity: ProtocolIntegrity;
}

export function createRecoveryRequest(input: Omit<RecoveryRequestV1, "format" | "version" | "critical" | "humanCode" | "integrity">): RecoveryRequestV1 {
  const request = normalizeRequest({
    ...input,
    format: "loom.recovery-request",
    version: 1,
    critical: REQUEST_CRITICAL,
    humanCode: humanRecoveryCode(input.requestId),
    integrity: { algorithm: "keccak256-canonical-json", digest: zero32() }
  }, false);
  return Object.freeze({ ...request, integrity: integrityFor(request) });
}

export function parseRecoveryRequest(value: string | unknown, options: { now?: number; chainId?: number; account?: Address } = {}): RecoveryRequestV1 {
  const parsed = normalizeRequest(typeof value === "string" ? parseJson(value, "request") : value, true);
  verifyIntegrity(parsed);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (parsed.expiresAt <= now) protocolError("INVALID_RECOVERY_REQUEST", "recovery request has expired");
  if (options.chainId !== undefined && parsed.chainId !== options.chainId) protocolError("DEPLOYMENT_CHAIN_MISMATCH", "recovery request is for another chain");
  if (options.account !== undefined && parsed.account !== address(options.account, "expected account")) protocolError("INVALID_RECOVERY_REQUEST", "recovery request is for another account");
  return parsed;
}

export function createRecoveryResponse(input: Omit<RecoveryResponseV1, "format" | "version" | "critical" | "integrity">): RecoveryResponseV1 {
  const response = normalizeResponse({
    ...input,
    format: "loom.recovery-response",
    version: 1,
    critical: RESPONSE_CRITICAL,
    integrity: { algorithm: "keccak256-canonical-json", digest: zero32() }
  }, false);
  return Object.freeze({ ...response, integrity: integrityFor(response) });
}

export function parseRecoveryResponse(value: string | unknown, request: RecoveryRequestV1, options: { now?: number } = {}): RecoveryResponseV1 {
  const parsed = normalizeResponse(typeof value === "string" ? parseJson(value, "response") : value, true);
  verifyIntegrity(parsed);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (parsed.expiresAt <= now || parsed.expiresAt > request.expiresAt) protocolError("INVALID_RECOVERY_RESPONSE", "recovery response is expired or outlives its request");
  if (parsed.requestId !== request.requestId || parsed.chainId !== request.chainId || parsed.account !== request.account) {
    protocolError("INVALID_RECOVERY_RESPONSE", "recovery response does not match its request");
  }
  return parsed;
}

export function createRecoverySignature(
  input: Omit<RecoverySignatureV1, "format" | "version" | "critical" | "integrity">
): RecoverySignatureV1 {
  const signature = normalizeSignature({
    ...input,
    format: "loom.recovery-signature",
    version: 1,
    critical: SIGNATURE_CRITICAL,
    integrity: { algorithm: "keccak256-canonical-json", digest: zero32() }
  }, false);
  return Object.freeze({ ...signature, integrity: integrityFor(signature) });
}

/**
 * Read a guardian's signature against the request it claims to answer.
 *
 * Bound to the request the same way a full response is. The digest is checked
 * rather than trusted: it commits to the account, the new validator, the
 * rotated guardian set, the configuration version and the nonce, so a
 * signature cannot be carried from one recovery to another.
 */
export function parseRecoverySignature(
  value: string | unknown,
  request: RecoveryRequestV1,
  options: { now?: number } = {}
): RecoverySignatureV1 {
  const parsed = normalizeSignature(typeof value === "string" ? parseJson(value, "signature") : value, true);
  verifyIntegrity(parsed);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (parsed.expiresAt <= now || parsed.expiresAt > request.expiresAt) {
    protocolError("INVALID_RECOVERY_RESPONSE", "recovery signature is expired or outlives its request");
  }
  if (parsed.requestId !== request.requestId || parsed.chainId !== request.chainId || parsed.account !== request.account) {
    protocolError("INVALID_RECOVERY_RESPONSE", "recovery signature does not match its request");
  }
  return parsed;
}

/**
 * Complete a bare signature into the response the proposal path already takes.
 *
 * The five capability fields come from the caller's own guardian set, which is
 * the only place they exist. Nothing downstream changes: the result is checked
 * against the live root exactly as a response from an invited guardian is.
 */
export function completeRecoverySignature(input: {
  readonly signature: RecoverySignatureV1;
  readonly guardian: {
    readonly leaf: Hex;
    readonly verifier: Address;
    readonly keyCommitment: Hex;
    readonly salt: Hex;
  };
  readonly proof: readonly Hex[];
}): RecoveryResponseV1 {
  return createRecoveryResponse({
    requestId: input.signature.requestId,
    chainId: input.signature.chainId,
    account: input.signature.account,
    recoveryDigest: input.signature.recoveryDigest,
    guardianLeaf: input.guardian.leaf,
    verifier: input.guardian.verifier,
    keyCommitment: input.guardian.keyCommitment,
    salt: input.guardian.salt,
    proof: input.proof,
    signature: input.signature.signature,
    signedAt: input.signature.signedAt,
    expiresAt: input.signature.expiresAt
  });
}

export function serializeRecoveryProtocol(value: RecoveryRequestV1 | RecoveryResponseV1 | RecoverySignatureV1): string {
  return canonicalJson(value);
}

/**
 * Project an off-chain guardian response onto the approval tuple
 * `RecoveryManager.proposeRecovery` accepts.
 *
 * This is what makes the two guardian choices interoperable rather than merely
 * parallel: a guardian who signs and shares privately and a guardian who
 * publishes on-chain sign the same digest and produce the same tuple, so a
 * bundle may mix them freely. `createRecoveryIntentBoardReader` yields the same
 * shape from a log, and both remain unverified until the recovery client
 * revalidates them against live guardian state.
 *
 * Callers must not treat the result as verified. It is a re-encoding of
 * attacker-supplied data.
 */
export function recoveryApprovalFromResponse(response: RecoveryResponseV1): {
  readonly verifier: Address;
  readonly keyCommitment: Hex;
  readonly salt: Hex;
  readonly signature: Hex;
  readonly proof: readonly Hex[];
  readonly leaf: Hex;
} {
  const parsed = normalizeResponse(response, true);
  return Object.freeze({
    verifier: parsed.verifier,
    keyCommitment: parsed.keyCommitment,
    salt: parsed.salt,
    signature: parsed.signature,
    proof: parsed.proof,
    leaf: parsed.guardianLeaf
  });
}

export function humanRecoveryCode(requestId: Hex): string {
  const value = BigInt(bytes32(requestId, "request id")) % 1_000_000n;
  return value.toString().padStart(6, "0");
}

function normalizeRequest(value: unknown, enforceIntegrity: boolean): RecoveryRequestV1 {
  const record = object(value, "recovery request");
  exactFields(record, REQUEST_FIELDS, "recovery request");
  if (record.format !== "loom.recovery-request" || record.version !== 1) protocolError("INVALID_RECOVERY_REQUEST", "unsupported recovery request format");
  critical(record.critical, REQUEST_CRITICAL, "INVALID_RECOVERY_REQUEST");
  const createdAt = timestamp(record.createdAt, "createdAt", "INVALID_RECOVERY_REQUEST");
  const expiresAt = timestamp(record.expiresAt, "expiresAt", "INVALID_RECOVERY_REQUEST");
  if (expiresAt <= createdAt || expiresAt - createdAt > 604_800) protocolError("INVALID_RECOVERY_REQUEST", "recovery request lifetime is invalid");
  const requestId = bytes32(record.requestId, "request id");
  const normalized = Object.freeze({
    format: "loom.recovery-request" as const,
    version: 1 as const,
    critical: Object.freeze([...REQUEST_CRITICAL]),
    requestId,
    chainId: positiveInteger(record.chainId, "chainId", "INVALID_RECOVERY_REQUEST"),
    account: address(record.account, "account"),
    recoveryManager: address(record.recoveryManager, "recovery manager"),
    guardianRoot: bytes32(record.guardianRoot, "guardian root"),
    guardianThreshold: boundedThreshold(record.guardianThreshold, "guardian threshold", "INVALID_RECOVERY_REQUEST"),
    configVersion: uintString(record.configVersion, "config version", "INVALID_RECOVERY_REQUEST"),
    nonce: uintString(record.nonce, "nonce", "INVALID_RECOVERY_REQUEST"),
    newValidator: address(record.newValidator, "new validator"),
    initDataHash: bytes32(record.initDataHash, "init data hash"),
    newGuardianRoot: bytes32(record.newGuardianRoot, "new guardian root"),
    newGuardianThreshold: boundedThreshold(record.newGuardianThreshold, "new guardian threshold", "INVALID_RECOVERY_REQUEST"),
    createdAt,
    expiresAt,
    humanCode: text(record.humanCode, "human code", 6, "INVALID_RECOVERY_REQUEST"),
    integrity: normalizeIntegrity(record.integrity, "INVALID_RECOVERY_REQUEST")
  });
  if (normalized.humanCode !== humanRecoveryCode(requestId)) protocolError("INVALID_RECOVERY_REQUEST", "recovery request human code is invalid");
  if (!enforceIntegrity) return normalized;
  return normalized;
}

function normalizeResponse(value: unknown, enforceIntegrity: boolean): RecoveryResponseV1 {
  const record = object(value, "recovery response");
  exactFields(record, RESPONSE_FIELDS, "recovery response");
  if (record.format !== "loom.recovery-response" || record.version !== 1) protocolError("INVALID_RECOVERY_RESPONSE", "unsupported recovery response format");
  critical(record.critical, RESPONSE_CRITICAL, "INVALID_RECOVERY_RESPONSE");
  const proof = record.proof;
  if (!Array.isArray(proof) || proof.length > 32) protocolError("INVALID_RECOVERY_RESPONSE", "recovery response proof is invalid");
  return Object.freeze({
    format: "loom.recovery-response" as const,
    version: 1 as const,
    critical: Object.freeze([...RESPONSE_CRITICAL]),
    requestId: bytes32(record.requestId, "request id"),
    chainId: positiveInteger(record.chainId, "chainId", "INVALID_RECOVERY_RESPONSE"),
    account: address(record.account, "account"),
    recoveryDigest: bytes32(record.recoveryDigest, "recovery digest"),
    guardianLeaf: bytes32(record.guardianLeaf, "guardian leaf"),
    verifier: address(record.verifier, "guardian verifier"),
    keyCommitment: bytes32(record.keyCommitment, "key commitment"),
    salt: bytes32(record.salt, "guardian salt"),
    proof: Object.freeze(proof.map((item, index) => bytes32(item, `proof[${index}]`))),
    signature: hexBytes(record.signature, "signature", 16_384),
    signedAt: timestamp(record.signedAt, "signedAt", "INVALID_RECOVERY_RESPONSE"),
    expiresAt: timestamp(record.expiresAt, "expiresAt", "INVALID_RECOVERY_RESPONSE"),
    integrity: normalizeIntegrity(record.integrity, "INVALID_RECOVERY_RESPONSE")
  });
}

function normalizeSignature(value: unknown, enforceIntegrity: boolean): RecoverySignatureV1 {
  const record = object(value, "recovery signature", "INVALID_RECOVERY_RESPONSE");
  exactFields(record, SIGNATURE_FIELDS, "recovery signature", "INVALID_RECOVERY_RESPONSE");
  if (record.format !== "loom.recovery-signature" || record.version !== 1) {
    protocolError("INVALID_RECOVERY_RESPONSE", "unsupported recovery signature format");
  }
  critical(record.critical, SIGNATURE_CRITICAL, "INVALID_RECOVERY_RESPONSE");
  return Object.freeze({
    format: "loom.recovery-signature" as const,
    version: 1 as const,
    critical: Object.freeze([...SIGNATURE_CRITICAL]),
    requestId: bytes32(record.requestId, "request id"),
    chainId: positiveInteger(record.chainId, "chainId", "INVALID_RECOVERY_RESPONSE"),
    account: address(record.account, "account"),
    recoveryDigest: bytes32(record.recoveryDigest, "recovery digest"),
    signature: hexBytes(record.signature, "signature", 16_384),
    signedAt: timestamp(record.signedAt, "signedAt", "INVALID_RECOVERY_RESPONSE"),
    expiresAt: timestamp(record.expiresAt, "expiresAt", "INVALID_RECOVERY_RESPONSE"),
    integrity: enforceIntegrity
      ? normalizeIntegrity(record.integrity, "INVALID_RECOVERY_RESPONSE")
      : { algorithm: "keccak256-canonical-json" as const, digest: zero32() }
  });
}

function integrityFor(value: RecoveryRequestV1 | RecoveryResponseV1 | RecoverySignatureV1): ProtocolIntegrity {
  const { integrity: _integrity, ...unsigned } = value;
  return Object.freeze({ algorithm: "keccak256-canonical-json", digest: keccak256(stringToHex(canonicalJson(unsigned))) });
}

function verifyIntegrity(value: RecoveryRequestV1 | RecoveryResponseV1 | RecoverySignatureV1): void {
  if (value.integrity.digest !== integrityFor(value).digest) {
    protocolError(value.format === "loom.recovery-request" ? "INVALID_RECOVERY_REQUEST" : "INVALID_RECOVERY_RESPONSE", "recovery protocol integrity check failed");
  }
}

function normalizeIntegrity(value: unknown, code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE"): ProtocolIntegrity {
  const record = object(value, "integrity");
  exactFields(record, ["algorithm", "digest"], "integrity");
  if (record.algorithm !== "keccak256-canonical-json") protocolError(code, "unsupported recovery protocol integrity algorithm");
  return Object.freeze({ algorithm: "keccak256-canonical-json", digest: bytes32(record.digest, "integrity digest") });
}

function critical(value: unknown, required: readonly string[], code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE"): void {
  if (!Array.isArray(value) || value.length !== required.length || value.some((item, index) => item !== required[index])) protocolError(code, "recovery protocol critical fields are invalid");
}

/**
 * `code` is explicit where the label does not name the artifact it belongs to.
 * A bare guardian signature is part of the response half of the protocol, but
 * saying "signature" made it report request errors.
 */
function exactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE" = label.includes("response") ? "INVALID_RECOVERY_RESPONSE" : "INVALID_RECOVERY_REQUEST"
): void {
  if (Object.keys(record).some(key => !allowed.includes(key))) protocolError(code, `${label} contains unknown fields`);
  if (allowed.some(key => !Object.hasOwn(record, key))) protocolError(code, `${label} is missing fields`);
}

function object(
  value: unknown,
  label: string,
  code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE" = label.includes("response") ? "INVALID_RECOVERY_RESPONSE" : "INVALID_RECOVERY_REQUEST"
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) protocolError(code, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) protocolError("INVALID_RECOVERY_REQUEST", `${label} must be an address`);
  return getAddress(value) as Address;
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) protocolError("INVALID_RECOVERY_REQUEST", `${label} must be bytes32`);
  return value.toLowerCase() as Hex;
}

function hexBytes(value: unknown, label: string, maxBytes: number): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value) || (value.length - 2) / 2 > maxBytes) protocolError("INVALID_RECOVERY_RESPONSE", `${label} is invalid`);
  return value.toLowerCase() as Hex;
}

function positiveInteger(value: unknown, label: string, code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) protocolError(code, `${label} must be a positive integer`);
  return value;
}

function boundedThreshold(value: unknown, label: string, code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE"): number {
  const result = positiveInteger(value, label, code);
  if (result > 32) protocolError(code, `${label} exceeds the guardian limit`);
  return result;
}

function timestamp(value: unknown, label: string, code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE"): number {
  return positiveInteger(value, label, code);
}

function uintString(value: unknown, label: string, code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE"): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) protocolError(code, `${label} must be an unsigned decimal string`);
  BigInt(value);
  return value;
}

function text(value: unknown, label: string, exactLength: number, code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE"): string {
  if (typeof value !== "string" || value.length !== exactLength) protocolError(code, `${label} is invalid`);
  return value;
}

function parseJson(value: string, label: string): unknown {
  if (value.length > 131_072) protocolError(label === "response" ? "INVALID_RECOVERY_RESPONSE" : "INVALID_RECOVERY_REQUEST", `recovery ${label} is too large`);
  try { return JSON.parse(value); }
  catch { protocolError(label === "response" ? "INVALID_RECOVERY_RESPONSE" : "INVALID_RECOVERY_REQUEST", `recovery ${label} is not valid JSON`); }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function zero32(): Hex { return `0x${"00".repeat(32)}`; }

function protocolError(code: "INVALID_RECOVERY_REQUEST" | "INVALID_RECOVERY_RESPONSE" | "DEPLOYMENT_CHAIN_MISMATCH", message: string): never {
  throw new GuardianRecoveryError(code, message, { safeMessage: "Recovery data could not be verified." });
}
