import {
  LoomAccountAbi,
  LoomAccountFactoryAbi,
  P256ValidatorAbi,
  base64UrlEncode,
  parseP256Signature,
  type Hex
} from "@loom/core";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  sha256,
  stringToHex
} from "viem";
import type { LoomStateReadTransport } from "./types.js";

export type Address = `0x${string}`;

const MAGIC = 0x4c;
const VERSION = 3;
const USER_HANDLE_LENGTH = 62;
const MAX_VALIDATORS = 16;
const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Address;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export interface PasskeyAccountLocator {
  readonly version: 3;
  readonly chainId: number;
  readonly factory: Address;
  readonly accountHandle: Hex;
}

export interface RawPasskeyAccountAssertion {
  readonly credentialId?: Hex;
  readonly userHandle: Hex;
  readonly authenticatorData: Hex;
  readonly clientDataJSON: Hex;
  /** ASN.1 DER or 64-byte IEEE P1363 `r || s`. */
  readonly signature: Hex;
}

export interface LivePasskeyPublicKey {
  readonly x: Hex;
  readonly y: Hex;
  readonly rpIdHash: Hex;
  readonly originHash: Hex;
}

export type PasskeyAssertionVerificationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "user-handle" | "ceremony" | "signature" };

export type PasskeyAccountDiscoveryResult =
  | { readonly status: "invalid"; readonly reason: "user-handle" | "deployment" | "assertion" }
  | { readonly status: "not-activated"; readonly locator: PasskeyAccountLocator }
  | {
      readonly status: "stale";
      readonly locator: PasskeyAccountLocator;
      readonly account: Address;
      readonly validators: readonly Address[];
    }
  | {
      readonly status: "active";
      readonly locator: PasskeyAccountLocator;
      readonly account: Address;
      readonly validator: Address;
      readonly publicKey: LivePasskeyPublicKey;
      readonly credentialId?: Hex;
    };

export class AccountDiscoveryError extends Error {
  readonly code: "UNAVAILABLE" | "RPC_DISAGREEMENT" | "INVALID_ACCOUNT_STATE";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: AccountDiscoveryError["code"],
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AccountDiscoveryError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** Create the random, non-zero handle used both as CREATE2 salt and registry key. */
export function createAccountHandle(random: Pick<Crypto, "getRandomValues"> = globalThis.crypto): Hex {
  if (!random?.getRandomValues) throw new TypeError("a cryptographically secure random source is required");
  for (;;) {
    const value = random.getRandomValues(new Uint8Array(32));
    if (value.some(byte => byte !== 0)) return bytesToHex(value);
  }
}

/** Encode Loom's 62-byte WebAuthn user.id/account locator. */
export function encodePasskeyAccountLocator(input: {
  readonly chainId: number;
  readonly factory: Address;
  readonly accountHandle: Hex;
}): Uint8Array {
  const chainId = positiveSafeInteger(input.chainId, "chainId");
  const factory = fixedBytes(input.factory, 20, "factory");
  const accountHandle = fixedBytes(input.accountHandle, 32, "account handle");
  if (allZero(factory)) throw new TypeError("factory must not be zero");
  if (allZero(accountHandle)) throw new TypeError("account handle must not be zero");
  const encoded = new Uint8Array(USER_HANDLE_LENGTH);
  encoded[0] = MAGIC;
  encoded[1] = VERSION;
  new DataView(encoded.buffer).setBigUint64(2, BigInt(chainId));
  encoded.set(factory, 10);
  encoded.set(accountHandle, 30);
  return encoded;
}

/** Decode only the current generation; legacy and future formats fail closed. */
export function decodePasskeyAccountLocator(value: ArrayBuffer | Uint8Array | Hex | null): PasskeyAccountLocator | null {
  if (value === null) return null;
  let bytes: Uint8Array;
  try {
    bytes = typeof value === "string"
      ? fixedBytes(value, USER_HANDLE_LENGTH, "userHandle")
      : value instanceof Uint8Array ? value : new Uint8Array(value);
  } catch {
    return null;
  }
  if (bytes.length !== USER_HANDLE_LENGTH || bytes[0] !== MAGIC || bytes[1] !== VERSION) return null;
  const chain = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(2);
  const factory = bytes.slice(10, 30);
  const accountHandle = bytes.slice(30);
  if (chain < 1n || chain > BigInt(Number.MAX_SAFE_INTEGER) || allZero(factory) || allZero(accountHandle)) return null;
  return Object.freeze({
    version: 3,
    chainId: Number(chain),
    factory: bytesToHex(factory) as Address,
    accountHandle: bytesToHex(accountHandle)
  });
}

/** Read `account -> H`, optionally requiring two independent RPCs to agree. */
export async function readAccountHandle(input: {
  readonly factory: Address;
  readonly account: Address;
  readonly stateTransport: LoomStateReadTransport;
  readonly verificationStateTransport?: LoomStateReadTransport;
}): Promise<Hex | null> {
  const result = await consensusRead(
    input.stateTransport,
    input.verificationStateTransport,
    address(input.factory, "factory"),
    LoomAccountFactoryAbi,
    "handleForAccount",
    [address(input.account, "account")]
  );
  const handle = bytes32(result, "account handle");
  return handle === ZERO_BYTES32 ? null : handle;
}

/** Read `H -> account`, optionally requiring two independent RPCs to agree. */
export async function lookupAccountForHandle(input: {
  readonly factory: Address;
  readonly accountHandle: Hex;
  readonly stateTransport: LoomStateReadTransport;
  readonly verificationStateTransport?: LoomStateReadTransport;
}): Promise<Address | null> {
  const result = await consensusRead(
    input.stateTransport,
    input.verificationStateTransport,
    address(input.factory, "factory"),
    LoomAccountFactoryAbi,
    "accountForHandle",
    [bytes32(input.accountHandle, "account handle")]
  );
  const account = address(result, "account");
  return account === ZERO_ADDRESS ? null : account;
}

/**
 * Resolve a passkey locator and prove that the same fresh assertion verifies
 * against a currently installed P-256 validator. Locator data never produces
 * `active` by itself.
 */
export async function discoverPasskeyAccount(input: {
  readonly chainId: number;
  readonly factory: Address;
  readonly rpId: string;
  readonly origin: string;
  readonly challenge: Hex;
  readonly assertion: RawPasskeyAccountAssertion;
  readonly stateTransport: LoomStateReadTransport;
  readonly verificationStateTransport?: LoomStateReadTransport;
  readonly crypto?: Crypto;
}): Promise<PasskeyAccountDiscoveryResult> {
  const locator = decodePasskeyAccountLocator(input.assertion.userHandle);
  if (!locator) return Object.freeze({ status: "invalid", reason: "user-handle" });
  const chainId = positiveSafeInteger(input.chainId, "chainId");
  const factory = address(input.factory, "factory");
  if (locator.chainId !== chainId || locator.factory.toLowerCase() !== factory.toLowerCase()) {
    return Object.freeze({ status: "invalid", reason: "deployment" });
  }

  const cryptography = input.crypto ?? globalThis.crypto;
  if (!cryptography?.subtle) throw new AccountDiscoveryError("UNAVAILABLE", "WebCrypto is unavailable");
  const ceremony = await verifyAssertionCeremony({
    assertion: input.assertion,
    challenge: bytes32(input.challenge, "challenge"),
    rpId: nonEmpty(input.rpId, "rpId"),
    origin: normalizedOrigin(input.origin),
    crypto: cryptography
  });
  if (!ceremony) return Object.freeze({ status: "invalid", reason: "assertion" });

  const account = await lookupAccountForHandle({
    factory,
    accountHandle: locator.accountHandle,
    stateTransport: input.stateTransport,
    ...(input.verificationStateTransport === undefined
      ? {}
      : { verificationStateTransport: input.verificationStateTransport })
  });
  if (!account) return Object.freeze({ status: "not-activated", locator });

  const validators = await readValidators(account, input.stateTransport, input.verificationStateTransport);
  const expectedRpIdHash = sha256(stringToHex(input.rpId));
  const expectedOriginHash = keccak256(stringToHex(normalizedOrigin(input.origin)));
  const unreadableValidators: Address[] = [];
  for (const validator of validators) {
    let key: LivePasskeyPublicKey;
    try {
      key = publicKey(await consensusRead(
        input.stateTransport,
        input.verificationStateTransport,
        validator,
        P256ValidatorAbi,
        "publicKeys",
        [account]
      ));
    } catch (cause) {
      if (cause instanceof AccountDiscoveryError && cause.code === "RPC_DISAGREEMENT") throw cause;
      unreadableValidators.push(validator);
      continue;
    }
    if (key.x === ZERO_BYTES32 || key.y === ZERO_BYTES32
      || key.rpIdHash.toLowerCase() !== expectedRpIdHash.toLowerCase()
      || key.originHash.toLowerCase() !== expectedOriginHash.toLowerCase()) continue;
    if (!await verifyP256Assertion(cryptography, key, ceremony.signedMessage, input.assertion.signature)) continue;
    return Object.freeze({
      status: "active",
      locator,
      account,
      validator,
      publicKey: key,
      ...(input.assertion.credentialId === undefined
        ? {}
        : { credentialId: variableHex(input.assertion.credentialId, "credentialId") })
    });
  }
  if (unreadableValidators.length > 0) {
    throw new AccountDiscoveryError(
      "UNAVAILABLE",
      "one or more live validators could not be inspected; stale status is unproven",
      { account, unreadableValidators }
    );
  }
  return Object.freeze({ status: "stale", locator, account, validators });
}

/** WebAuthn credential backup eligibility/state flags (BE/BS). */
export function passkeyBackupState(authenticatorData: Hex | Uint8Array): {
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
} {
  const bytes = typeof authenticatorData === "string"
    ? variableBytes(authenticatorData, "authenticatorData")
    : authenticatorData;
  if (bytes.length < 37) throw new TypeError("authenticator data must contain at least 37 bytes");
  const backupEligible = (bytes[32]! & 0x08) !== 0;
  const backedUp = (bytes[32]! & 0x10) !== 0;
  if (backedUp && !backupEligible) throw new TypeError("invalid WebAuthn backup flags");
  return Object.freeze({ backupEligible, backedUp });
}

/**
 * Verify a fresh assertion against a newly registered credential before its
 * public key is accepted into an account configuration. This performs no chain
 * lookup: callers provide the exact v3 user handle and P-256 key registration
 * just returned, and every WebAuthn ceremony property fails closed.
 */
export async function verifyPasskeyAssertion(input: {
  readonly rpId: string;
  readonly origin: string;
  readonly challenge: Hex;
  readonly expectedUserHandle: Hex;
  readonly publicKey: Pick<LivePasskeyPublicKey, "x" | "y">;
  readonly assertion: RawPasskeyAccountAssertion;
  readonly crypto?: Crypto;
}): Promise<PasskeyAssertionVerificationResult> {
  let actualUserHandle: Hex;
  let expectedUserHandle: Hex;
  try {
    actualUserHandle = variableHex(input.assertion.userHandle, "userHandle");
    expectedUserHandle = variableHex(input.expectedUserHandle, "expected userHandle");
  } catch {
    return Object.freeze({ valid: false, reason: "user-handle" });
  }
  if (actualUserHandle !== expectedUserHandle) {
    return Object.freeze({ valid: false, reason: "user-handle" });
  }

  const cryptography = input.crypto ?? globalThis.crypto;
  if (!cryptography?.subtle) throw new AccountDiscoveryError("UNAVAILABLE", "WebCrypto is unavailable");
  const ceremony = await verifyAssertionCeremony({
    assertion: input.assertion,
    challenge: bytes32(input.challenge, "challenge"),
    rpId: nonEmpty(input.rpId, "rpId"),
    origin: normalizedOrigin(input.origin),
    crypto: cryptography
  });
  if (!ceremony) return Object.freeze({ valid: false, reason: "ceremony" });
  const verified = await verifyP256Assertion(cryptography, input.publicKey, ceremony.signedMessage, input.assertion.signature);
  return verified
    ? Object.freeze({ valid: true })
    : Object.freeze({ valid: false, reason: "signature" });
}

async function readValidators(
  account: Address,
  state: LoomStateReadTransport,
  verification?: LoomStateReadTransport
): Promise<readonly Address[]> {
  const countValue = await consensusRead(state, verification, account, LoomAccountAbi, "validatorCount");
  const count = uint(countValue, "validator count");
  if (count < 1n || count > BigInt(MAX_VALIDATORS)) {
    throw new AccountDiscoveryError("INVALID_ACCOUNT_STATE", "validator count exceeds the protocol bound", {
      account, validatorCount: count.toString(), maximum: MAX_VALIDATORS
    });
  }
  const validators: Address[] = [];
  for (let index = 0n; index < count; index += 1n) {
    validators.push(address(
      await consensusRead(state, verification, account, LoomAccountAbi, "validatorAt", [index]),
      "validator"
    ));
  }
  return Object.freeze(validators);
}

async function verifyAssertionCeremony(input: {
  assertion: RawPasskeyAccountAssertion;
  challenge: Hex;
  rpId: string;
  origin: string;
  crypto: Crypto;
}): Promise<{ readonly signedMessage: Uint8Array } | null> {
  let authenticatorData: Uint8Array;
  let clientDataJSON: Uint8Array;
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    authenticatorData = variableBytes(input.assertion.authenticatorData, "authenticatorData");
    clientDataJSON = variableBytes(input.assertion.clientDataJSON, "clientDataJSON");
    client = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    return null;
  }
  if (authenticatorData.length < 37 || client.type !== "webauthn.get"
    || client.challenge !== base64UrlEncode(input.challenge)
    || client.origin !== input.origin || client.crossOrigin === true) return null;
  const expectedRpIdHash = hexToBytes(sha256(stringToHex(input.rpId)));
  if (!equalBytes(authenticatorData.slice(0, 32), expectedRpIdHash)) return null;
  const flags = authenticatorData[32]!;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return null;
  const clientHash = new Uint8Array(await input.crypto.subtle.digest("SHA-256", ownedBuffer(clientDataJSON)));
  const signedMessage = new Uint8Array(authenticatorData.length + clientHash.length);
  signedMessage.set(authenticatorData);
  signedMessage.set(clientHash, authenticatorData.length);
  return Object.freeze({ signedMessage });
}

async function verifyP256Assertion(
  cryptography: Crypto,
  key: Pick<LivePasskeyPublicKey, "x" | "y">,
  message: Uint8Array,
  signature: Hex
): Promise<boolean> {
  try {
    const parsed = parseP256Signature(variableHex(signature, "signature"));
    const publicKey = await cryptography.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: base64UrlEncode(key.x), y: base64UrlEncode(key.y), ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const rawSignature = concatBytes(hexToBytes(parsed.r), hexToBytes(parsed.s));
    return await cryptography.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey, ownedBuffer(rawSignature), ownedBuffer(message)
    );
  } catch {
    return false;
  }
}

async function consensusRead(
  primary: LoomStateReadTransport,
  verification: LoomStateReadTransport | undefined,
  to: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = []
): Promise<unknown> {
  const read = async (transport: LoomStateReadTransport): Promise<unknown> => {
    try {
      const data = encodeFunctionData({ abi: abi as any, functionName: functionName as any, args: args as any });
      const result = await transport.ethCall({ to, data });
      return decodeFunctionResult({ abi: abi as any, functionName: functionName as any, data: result });
    } catch (cause) {
      throw new AccountDiscoveryError("UNAVAILABLE", `failed to read ${functionName}`, { to, functionName }, { cause });
    }
  };
  const result = await read(primary);
  if (!verification) return result;
  const verified = await read(verification);
  if (canonical(result) !== canonical(verified)) {
    throw new AccountDiscoveryError("RPC_DISAGREEMENT", `RPCs disagree about ${functionName}`, { to, functionName });
  }
  return result;
}

function publicKey(value: unknown): LivePasskeyPublicKey {
  if (!Array.isArray(value) || value.length !== 4) throw new TypeError("validator public key is invalid");
  return Object.freeze({
    x: bytes32(value[0], "x"),
    y: bytes32(value[1], "y"),
    rpIdHash: bytes32(value[2], "rpIdHash"),
    originHash: bytes32(value[3], "originHash")
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)?.toLowerCase();
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return Number(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function normalizedOrigin(value: unknown): string {
  const origin = nonEmpty(value, "origin");
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) throw new Error();
    return origin;
  } catch {
    throw new TypeError("origin must be a canonical HTTP(S) origin");
  }
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new TypeError(`${label} must be an address`);
  return value.toLowerCase() as Address;
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new TypeError(`${label} must be bytes32`);
  return value.toLowerCase() as Hex;
}

function variableHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(value)) throw new TypeError(`${label} must be non-empty byte-aligned hex`);
  return value.toLowerCase() as Hex;
}

function fixedBytes(value: unknown, size: number, label: string): Uint8Array {
  const bytes = variableBytes(value, label);
  if (bytes.length !== size) throw new TypeError(`${label} must be ${size} bytes`);
  return bytes;
}

function variableBytes(value: unknown, label: string): Uint8Array {
  return hexToBytes(variableHex(value, label));
}

function hexToBytes(value: Hex): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/.{2}/gu)?.map(pair => Number.parseInt(pair, 16)) ?? []);
}

function bytesToHex(value: Uint8Array): Hex {
  return `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function allZero(value: Uint8Array): boolean {
  return value.every(byte => byte === 0);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const value = new Uint8Array(left.length + right.length);
  value.set(left);
  value.set(right, left.length);
  return value;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError(`${label} must be an unsigned integer`);
  return value;
}
