import type { Address, Hex } from "@loom/core";
import { getAddress, isAddress, keccak256, stringToHex } from "viem";
import {
  GuardianRecoveryError,
  createGuardianLeaf,
  createGuardianProof,
  validateGuardianInvite,
  verifyGuardianProof,
  type GuardianInviteV1,
  type GuardianSet,
  type GuardianSetMember
} from "./recovery.js";

const TOP_FIELDS = ["format", "version", "critical", "chainId", "account", "accountAlias", "issuerLabel", "recoveryManager", "capabilityId", "expiresAt", "current", "standby", "integrity"] as const;
const CRITICAL = ["chainId", "account", "recoveryManager", "capabilityId", "expiresAt", "current", "standby"] as const;
const EPOCH_FIELDS = ["role", "guardianSetVersion", "configVersion", "root", "threshold", "guardianCount", "guardian", "proof", "operationId", "readyAt"] as const;
const MEMBER_FIELDS = ["kind", "verifier", "verifierCodeHash", "keyCommitment", "salt", "leaf"] as const;

export interface GuardianCapabilityEpochV2 {
  readonly role: "current" | "standby";
  readonly guardianSetVersion: number;
  readonly configVersion: string;
  readonly root: Hex;
  readonly threshold: number;
  readonly guardianCount: number;
  readonly guardian: GuardianSetMember;
  readonly proof: readonly Hex[];
  readonly operationId: Hex;
  readonly readyAt: string;
}

export interface GuardianCapabilityV2 {
  readonly format: "loom.guardian-capability";
  readonly version: 2;
  readonly critical: readonly string[];
  readonly chainId: number;
  readonly account: Address;
  readonly accountAlias: string;
  readonly issuerLabel: string;
  readonly recoveryManager: Address;
  readonly capabilityId: Hex;
  readonly expiresAt: number;
  readonly current: GuardianCapabilityEpochV2;
  readonly standby: GuardianCapabilityEpochV2;
  readonly integrity: { readonly algorithm: "keccak256-canonical-json"; readonly digest: Hex };
}

export interface GuardianCapabilityView {
  readonly capability: GuardianInviteV1 | GuardianCapabilityV2;
  readonly recoveryCompleteness: "complete" | "current-only";
  readonly current: { readonly root: Hex; readonly configVersion: string; readonly guardian: GuardianSetMember; readonly proof: readonly Hex[] };
  readonly standby?: GuardianCapabilityEpochV2;
}

export function createGuardianCapabilityV2(input: {
  readonly chainId: number;
  readonly account: Address;
  readonly accountAlias: string;
  readonly issuerLabel: string;
  readonly recoveryManager: Address;
  readonly capabilityId: Hex;
  readonly expiresAt: number;
  readonly current: { readonly set: GuardianSet; readonly guardianLeaf: Hex; readonly guardianSetVersion: number; readonly configVersion: bigint | number | string };
  readonly standby: { readonly set: GuardianSet; readonly guardianLeaf: Hex; readonly guardianSetVersion: number; readonly configVersion: bigint | number | string; readonly operationId: Hex; readonly readyAt: bigint | number | string };
}): GuardianCapabilityV2 {
  const current = epoch("current", input.current, zero32(), 0n);
  const standby = epoch("standby", input.standby, input.standby.operationId, input.standby.readyAt);
  assertSameAuthority(current, standby);
  if (current.root === standby.root || current.guardian.salt === standby.guardian.salt) invalid("standby epoch must rotate guardian salts and root");
  if (BigInt(standby.configVersion) < BigInt(current.configVersion) || standby.operationId === zero32() || BigInt(standby.readyAt) <= 0n) invalid("standby epoch activation binding is invalid");
  const unsigned = {
    format: "loom.guardian-capability" as const,
    version: 2 as const,
    critical: Object.freeze([...CRITICAL]),
    chainId: positive(input.chainId, "chainId"),
    account: address(input.account, "account"),
    accountAlias: bounded(input.accountAlias, "account alias", 80),
    issuerLabel: bounded(input.issuerLabel, "issuer label", 80),
    recoveryManager: address(input.recoveryManager, "recovery manager"),
    capabilityId: bytes32(input.capabilityId, "capability id"),
    expiresAt: positive(input.expiresAt, "expiry"),
    current,
    standby
  };
  return freeze({ ...unsigned, integrity: { algorithm: "keccak256-canonical-json", digest: hash(unsigned) } });
}

export function parseGuardianCapability(text: string, expected: { readonly chainId?: number; readonly account?: Address; readonly currentRoot?: Hex; readonly configVersion?: bigint | number | string; readonly now?: number } = {}): GuardianCapabilityView {
  if (typeof text !== "string" || text.length < 2 || text.length > 65_536) invalid("guardian capability size is invalid");
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid("guardian capability is not valid JSON"); }
  const version = object(value, "guardian capability").version;
  if (version === 1) {
    const legacy = validateGuardianInvite(value, {
      ...(expected.chainId === undefined ? {} : { chainId: expected.chainId }),
      ...(expected.account === undefined ? {} : { account: expected.account }),
      ...(expected.currentRoot === undefined ? {} : { guardianRoot: expected.currentRoot }),
      ...(expected.configVersion === undefined ? {} : { configVersion: expected.configVersion }),
      ...(expected.now === undefined ? {} : { now: expected.now })
    });
    return freeze({ capability: legacy, recoveryCompleteness: "current-only" as const, current: { root: legacy.guardianRoot, configVersion: legacy.configVersion, guardian: legacy.guardian, proof: legacy.proof } });
  }
  const capability = normalizeV2(value);
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  if (capability.expiresAt <= now) invalid("guardian capability has expired");
  if (expected.chainId !== undefined && capability.chainId !== expected.chainId) throw new GuardianRecoveryError("DEPLOYMENT_CHAIN_MISMATCH", "guardian capability is for another chain");
  if (expected.account !== undefined && capability.account !== address(expected.account, "expected account")) stale("guardian capability is for another account");
  if (expected.currentRoot !== undefined && capability.current.root !== bytes32(expected.currentRoot, "expected current root")) stale("guardian capability current epoch is stale");
  if (expected.configVersion !== undefined && capability.current.configVersion !== uint(expected.configVersion, "expected config version")) stale("guardian capability config version is stale");
  return freeze({ capability, recoveryCompleteness: "complete" as const, current: capability.current, standby: capability.standby });
}

export function serializeGuardianCapability(capability: GuardianCapabilityV2): string {
  return canonical(normalizeV2(capability));
}

function normalizeV2(value: unknown): GuardianCapabilityV2 {
  const record = object(value, "guardian capability");
  exact(record, TOP_FIELDS, "guardian capability");
  if (record.format !== "loom.guardian-capability" || record.version !== 2) invalid("unsupported guardian capability format");
  if (!Array.isArray(record.critical) || record.critical.length !== CRITICAL.length || record.critical.some((item, index) => item !== CRITICAL[index])) invalid("guardian capability critical fields are invalid");
  const current = normalizeEpoch(record.current, "current");
  const standby = normalizeEpoch(record.standby, "standby");
  assertSameAuthority(current, standby);
  if (current.root === standby.root || current.guardian.salt === standby.guardian.salt) invalid("guardian capability standby epoch does not rotate salts");
  if (BigInt(standby.configVersion) < BigInt(current.configVersion) || standby.operationId === zero32() || BigInt(standby.readyAt) <= 0n) invalid("standby epoch activation binding is invalid");
  const integrity = object(record.integrity, "guardian capability integrity");
  exact(integrity, ["algorithm", "digest"], "guardian capability integrity");
  if (integrity.algorithm !== "keccak256-canonical-json") invalid("unsupported guardian capability integrity algorithm");
  const { integrity: _integrity, ...unsigned } = record;
  if (bytes32(integrity.digest, "integrity digest") !== hash(unsigned)) invalid("guardian capability integrity check failed");
  return freeze({
    format: "loom.guardian-capability" as const,
    version: 2 as const,
    critical: Object.freeze([...CRITICAL]),
    chainId: positive(record.chainId, "chainId"),
    account: address(record.account, "account"),
    accountAlias: bounded(record.accountAlias, "account alias", 80),
    issuerLabel: bounded(record.issuerLabel, "issuer label", 80),
    recoveryManager: address(record.recoveryManager, "recovery manager"),
    capabilityId: bytes32(record.capabilityId, "capability id"),
    expiresAt: positive(record.expiresAt, "expiry"),
    current,
    standby,
    integrity: { algorithm: "keccak256-canonical-json", digest: bytes32(integrity.digest, "integrity digest") }
  });
}

function epoch(role: "current" | "standby", input: { readonly set: GuardianSet; readonly guardianLeaf: Hex; readonly guardianSetVersion: number; readonly configVersion: bigint | number | string }, operationId: Hex, readyAt: bigint | number | string): GuardianCapabilityEpochV2 {
  const leaf = bytes32(input.guardianLeaf, `${role} guardian leaf`);
  const guardian = input.set.guardians.find(item => item.leaf === leaf);
  if (!guardian) invalid(`${role} guardian is not in its set`);
  if (createGuardianLeaf(guardian) !== guardian.leaf || !verifyGuardianProof({ root: input.set.root, leaf, proof: createGuardianProof(input.set, leaf) })) invalid(`${role} guardian set is inconsistent`);
  return freeze({ role, guardianSetVersion: positive(input.guardianSetVersion, `${role} set version`), configVersion: uint(input.configVersion, `${role} config version`), root: input.set.root, threshold: input.set.threshold, guardianCount: input.set.guardians.length, guardian, proof: createGuardianProof(input.set, leaf), operationId: bytes32(operationId, `${role} operation id`), readyAt: uint(readyAt, `${role} ready time`) });
}

function normalizeEpoch(value: unknown, expectedRole: "current" | "standby"): GuardianCapabilityEpochV2 {
  const record = object(value, `${expectedRole} epoch`);
  exact(record, EPOCH_FIELDS, `${expectedRole} epoch`);
  if (record.role !== expectedRole) invalid(`guardian capability ${expectedRole} epoch role is invalid`);
  const guardianRecord = object(record.guardian, `${expectedRole} guardian`);
  exact(guardianRecord, MEMBER_FIELDS, `${expectedRole} guardian`);
  if (!["ecdsa", "p256", "erc1271"].includes(String(guardianRecord.kind))) invalid("guardian kind is invalid");
  const guardian = freeze({ kind: guardianRecord.kind as GuardianSetMember["kind"], verifier: address(guardianRecord.verifier, "guardian verifier"), verifierCodeHash: bytes32(guardianRecord.verifierCodeHash, "verifier code hash"), keyCommitment: bytes32(guardianRecord.keyCommitment, "key commitment"), salt: bytes32(guardianRecord.salt, "guardian salt"), leaf: bytes32(guardianRecord.leaf, "guardian leaf") });
  if (createGuardianLeaf(guardian) !== guardian.leaf) invalid("guardian leaf does not match its commitment");
  const proofValue = record.proof;
  if (!Array.isArray(proofValue) || proofValue.length > 32) invalid("guardian proof is invalid");
  const proof = Object.freeze(proofValue.map(item => bytes32(item, "guardian proof item")));
  const root = bytes32(record.root, `${expectedRole} root`);
  if (!verifyGuardianProof({ root, leaf: guardian.leaf, proof })) invalid(`${expectedRole} guardian proof does not match its root`);
  const guardianCount = positive(record.guardianCount, "guardian count");
  const required = threshold(record.threshold);
  if (required > guardianCount || guardianCount > 32) invalid("guardian epoch threshold and count are inconsistent");
  return freeze({ role: expectedRole, guardianSetVersion: positive(record.guardianSetVersion, "guardian set version"), configVersion: uint(record.configVersion, "config version"), root, threshold: required, guardianCount, guardian, proof, operationId: bytes32(record.operationId, "operation id"), readyAt: uint(record.readyAt, "ready time") });
}

function assertSameAuthority(current: GuardianCapabilityEpochV2, standby: GuardianCapabilityEpochV2): void {
  if (current.guardian.kind !== standby.guardian.kind || current.guardian.keyCommitment !== standby.guardian.keyCommitment || current.guardian.verifier !== standby.guardian.verifier || current.guardian.verifierCodeHash !== standby.guardian.verifierCodeHash) invalid("guardian capability epochs bind different authorities");
}

function exact(record: Record<string, unknown>, fields: readonly string[], label: string): void { if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(record, key))) invalid(`${label} fields are invalid`); }
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`); return value as Record<string, unknown>; }
function address(value: unknown, label: string): Address { if (typeof value !== "string" || !isAddress(value, { strict: false })) invalid(`${label} must be an address`); return getAddress(value) as Address; }
function bytes32(value: unknown, label: string): Hex { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(`${label} must be bytes32`); return value.toLowerCase() as Hex; }
function positive(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be positive`); return value; }
function threshold(value: unknown): number { const result = positive(value, "threshold"); if (result > 32) invalid("threshold exceeds guardian limit"); return result; }
function uint(value: unknown, label: string): string { try { const result = BigInt(value as string | number | bigint); if (result < 0n || result > 18_446_744_073_709_551_615n) invalid(`${label} is outside uint64`); return result.toString(); } catch { invalid(`${label} is invalid`); } }
function bounded(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.trim().length === 0 || value.length > max) invalid(`${label} is invalid`); return value.trim(); }
function hash(value: unknown): Hex { return keccak256(stringToHex(canonical(value))); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
function freeze<T>(value: T): Readonly<T> { if (value && typeof value === "object") { for (const item of Object.values(value as Record<string, unknown>)) freeze(item); Object.freeze(value); } return value; }
function zero32(): Hex { return `0x${"00".repeat(32)}`; }
function invalid(message: string): never { throw new GuardianRecoveryError("INVALID_GUARDIAN_INVITE", message, { safeMessage: "Guardian capability could not be verified." }); }
function stale(message: string): never { throw new GuardianRecoveryError("STALE_GUARDIAN_INVITE", message, { safeMessage: "Guardian capability no longer matches the account." }); }
