import type { RecoveryRequestV1, RecoveryResponseV1 } from "@loom/sdk/recovery";
import { parseRecoveryRequest, parseRecoveryResponse } from "@loom/sdk/recovery";
import { createEncryptedStore, type EncryptedStore } from "../../storage/encryptedStore.ts";
import { parseRosterRecord } from "../../storage/guardianRosterRecord.ts";
import type { RosterEntry } from "../security/guardianPlan.ts";

export interface RecoveryLocalMaterial {
  readonly initData: `0x${string}`;
  readonly credentialId: `0x${string}`;
  readonly publicKey: { readonly x: `0x${string}`; readonly y: `0x${string}` };
  readonly rpId: string;
  readonly origin: string;
  readonly freshGuardianEntries: readonly RosterEntry[];
  readonly oldValidators?: readonly `0x${string}`[];
}

export type RecoverySessionStage =
  | "request-created"
  | "collecting"
  | "ready-to-propose"
  | "delay-active"
  | "ready-to-execute"
  | "completed"
  | "cancelled"
  | "expired"
  | "blocked";

export interface RecoverySession {
  readonly version: 1;
  readonly id: string;
  readonly stage: RecoverySessionStage;
  readonly request: RecoveryRequestV1;
  readonly responses: readonly RecoveryResponseV1[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly transactionHash?: `0x${string}`;
  readonly executionTransactionHash?: `0x${string}`;
  readonly readyAt?: string;
  readonly expiresAt?: string;
  readonly blocker?: "UNSUPPORTED_RECOVERED_VALIDATOR_PATH" | "CHAIN_STATE_CHANGED";
  /** Device-local execution material; never included in the portable request. */
  readonly local?: RecoveryLocalMaterial;
}

export interface RecoverySessionIssue {
  readonly key: string;
  readonly reason: "corrupt" | "invalid";
}

export interface RecoverySessionSnapshot {
  readonly sessions: readonly RecoverySession[];
  readonly issues: readonly RecoverySessionIssue[];
}

export interface RecoverySessionRepository {
  inspect(): Promise<RecoverySessionSnapshot>;
  read(id: string): Promise<RecoverySession | null>;
  write(session: RecoverySession): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createRecoverySessionRepository(
  store: EncryptedStore = createEncryptedStore("loom-recovery-sessions-v1")
): RecoverySessionRepository {
  const inspect = async (): Promise<RecoverySessionSnapshot> => {
    const sessions: RecoverySession[] = [];
    const issues: RecoverySessionIssue[] = [];
    for (const entry of await store.entries()) {
      if (entry.corrupt) {
        issues.push(Object.freeze({ key: entry.key, reason: "corrupt" }));
        continue;
      }
      try {
        const session = parseRecoverySession(entry.value);
        if (session.id !== entry.key) throw new Error("session key mismatch");
        sessions.push(session);
      } catch {
        issues.push(Object.freeze({ key: entry.key, reason: "invalid" }));
      }
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    return Object.freeze({ sessions: Object.freeze(sessions), issues: Object.freeze(issues) });
  };
  const repository: RecoverySessionRepository = {
    inspect,
    async read(id: string) { return (await inspect()).sessions.find(session => session.id === id) ?? null; },
    async write(session: RecoverySession) {
      const parsed = parseRecoverySession(session);
      await store.put(parsed.id, parsed);
    },
    async remove(id: string) { await store.remove(id); }
  };
  return Object.freeze(repository);
}

export function createRecoverySession(request: RecoveryRequestV1, now = Date.now(), local?: RecoveryLocalMaterial): RecoverySession {
  const checked = parseRecoveryRequest(request, { now: Math.floor(now / 1000) });
  return Object.freeze({
    version: 1,
    id: checked.requestId,
    stage: "request-created",
    request: checked,
    responses: Object.freeze([]),
    createdAt: now,
    updatedAt: now,
    ...(local ? { local: parseLocalMaterial(local, checked.account) } : {})
  });
}

export type RecoverySessionEvent =
  | { readonly type: "response-added"; readonly response: RecoveryResponseV1; readonly approvalsRequired: number }
  | { readonly type: "proposal-confirmed"; readonly transactionHash: `0x${string}`; readonly readyAt: bigint; readonly expiresAt: bigint }
  | { readonly type: "chain-ready" }
  | { readonly type: "completed"; readonly transactionHash?: `0x${string}` }
  | { readonly type: "cancelled" }
  | { readonly type: "expired" }
  | { readonly type: "blocked"; readonly blocker: RecoverySession["blocker"] };

export function transitionRecoverySession(session: RecoverySession, event: RecoverySessionEvent, now = Date.now()): RecoverySession {
  const current = parseRecoverySession(session);
  const update = (patch: Partial<RecoverySession>) => parseRecoverySession({ ...current, ...patch, updatedAt: now });
  switch (event.type) {
    case "response-added": {
      if (current.stage !== "request-created" && current.stage !== "collecting") invalidTransition(current.stage, event.type);
      if (!Number.isInteger(event.approvalsRequired) || event.approvalsRequired < 1 || event.approvalsRequired > 32) throw new Error("approval threshold is invalid");
      const response = parseRecoveryResponse(event.response, current.request, { now: Math.floor(now / 1000) });
      if (current.responses.some(item => item.guardianLeaf === response.guardianLeaf)) throw new Error("guardian response is duplicated");
      const responses = Object.freeze([...current.responses, response]);
      return update({ responses, stage: responses.length >= event.approvalsRequired ? "ready-to-propose" : "collecting" });
    }
    case "proposal-confirmed":
      if (current.stage !== "ready-to-propose") invalidTransition(current.stage, event.type);
      if (event.readyAt <= 0n || event.expiresAt <= event.readyAt) throw new Error("recovery window is invalid");
      return update({ stage: "delay-active", transactionHash: event.transactionHash, readyAt: event.readyAt.toString(), expiresAt: event.expiresAt.toString() });
    case "chain-ready":
      if (current.stage !== "delay-active") invalidTransition(current.stage, event.type);
      return update({ stage: "ready-to-execute" });
    case "completed":
      if (current.stage !== "ready-to-execute") invalidTransition(current.stage, event.type);
      return update({ stage: "completed", ...(event.transactionHash ? { executionTransactionHash: event.transactionHash } : {}) });
    case "cancelled":
      if (["completed", "cancelled", "expired"].includes(current.stage)) invalidTransition(current.stage, event.type);
      return update({ stage: "cancelled" });
    case "expired":
      if (["completed", "cancelled", "expired"].includes(current.stage)) invalidTransition(current.stage, event.type);
      return update({ stage: "expired" });
    case "blocked":
      if (["completed", "cancelled", "expired"].includes(current.stage) || !event.blocker) invalidTransition(current.stage, event.type);
      return update({ stage: "blocked", blocker: event.blocker });
  }
}

export function parseRecoverySession(value: unknown): RecoverySession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery session is invalid");
  const record = value as Record<string, unknown>;
  const allowed = ["version", "id", "stage", "request", "responses", "createdAt", "updatedAt", "transactionHash", "executionTransactionHash", "readyAt", "expiresAt", "blocker", "local"];
  if (Object.keys(record).some(key => !allowed.includes(key)) || record.version !== 1) throw new Error("recovery session format is invalid");
  const request = parseRecoveryRequest(record.request, { now: 1 });
  if (record.id !== request.requestId) throw new Error("recovery session id is invalid");
  const stages: readonly RecoverySessionStage[] = ["request-created", "collecting", "ready-to-propose", "delay-active", "ready-to-execute", "completed", "cancelled", "expired", "blocked"];
  if (!stages.includes(record.stage as RecoverySessionStage)) throw new Error("recovery session stage is invalid");
  if (!Array.isArray(record.responses) || record.responses.length > 32) throw new Error("recovery responses are invalid");
  const responses = Object.freeze(record.responses.map(response => parseRecoveryResponse(response, request, { now: 1 })));
  if (new Set(responses.map(response => response.guardianLeaf)).size !== responses.length) throw new Error("recovery responses contain duplicates");
  const createdAt = finiteTime(record.createdAt, "createdAt");
  const updatedAt = finiteTime(record.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("recovery session timestamps are invalid");
  if (record.transactionHash !== undefined && (typeof record.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.transactionHash))) throw new Error("recovery transaction hash is invalid");
  if (record.executionTransactionHash !== undefined && (typeof record.executionTransactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.executionTransactionHash))) throw new Error("recovery execution transaction hash is invalid");
  if (record.readyAt !== undefined && !uintString(record.readyAt)) throw new Error("recovery ready time is invalid");
  if (record.expiresAt !== undefined && !uintString(record.expiresAt)) throw new Error("recovery expiry is invalid");
  if (record.blocker !== undefined && record.blocker !== "UNSUPPORTED_RECOVERED_VALIDATOR_PATH" && record.blocker !== "CHAIN_STATE_CHANGED") throw new Error("recovery blocker is invalid");
  return Object.freeze({
    version: 1,
    id: request.requestId,
    stage: record.stage as RecoverySessionStage,
    request,
    responses,
    createdAt,
    updatedAt,
    ...(record.transactionHash === undefined ? {} : { transactionHash: record.transactionHash as `0x${string}` }),
    ...(record.executionTransactionHash === undefined ? {} : { executionTransactionHash: record.executionTransactionHash as `0x${string}` }),
    ...(record.readyAt === undefined ? {} : { readyAt: record.readyAt as string }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt as string }),
    ...(record.blocker === undefined ? {} : { blocker: record.blocker as Exclude<RecoverySession["blocker"], undefined> }),
    ...(record.local === undefined ? {} : { local: parseLocalMaterial(record.local, request.account) })
  });
}

function parseLocalMaterial(value: unknown, account: string): RecoveryLocalMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery local material is invalid");
  const record = value as Record<string, unknown>;
  const allowed = ["initData", "credentialId", "publicKey", "rpId", "origin", "freshGuardianEntries", "oldValidators"];
  const required = allowed.filter(key => key !== "oldValidators");
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key))) throw new Error("recovery local material format is invalid");
  if (typeof record.initData !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(record.initData)) throw new Error("recovery init data is invalid");
  if (typeof record.credentialId !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(record.credentialId)) throw new Error("recovery credential is invalid");
  if (!record.publicKey || typeof record.publicKey !== "object" || Array.isArray(record.publicKey)) throw new Error("recovery public key is invalid");
  const publicKey = record.publicKey as Record<string, unknown>;
  if (!bytes32(publicKey.x) || !bytes32(publicKey.y)) throw new Error("recovery public key is invalid");
  if (typeof record.rpId !== "string" || record.rpId.length < 1 || record.rpId.length > 253) throw new Error("recovery RP ID is invalid");
  if (typeof record.origin !== "string" || record.origin.length < 1 || record.origin.length > 2048) throw new Error("recovery origin is invalid");
  const roster = parseRosterRecord({ version: 1, accountId: account, setVersion: 1, entries: record.freshGuardianEntries }, account);
  if (record.oldValidators !== undefined && (!Array.isArray(record.oldValidators) || record.oldValidators.length < 1 || record.oldValidators.length > 16 || record.oldValidators.some(item => typeof item !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(item)))) throw new Error("recovery old validators are invalid");
  return Object.freeze({
    initData: record.initData.toLowerCase() as `0x${string}`,
    credentialId: record.credentialId.toLowerCase() as `0x${string}`,
    publicKey: Object.freeze({ x: String(publicKey.x).toLowerCase() as `0x${string}`, y: String(publicKey.y).toLowerCase() as `0x${string}` }),
    rpId: record.rpId,
    origin: record.origin,
    freshGuardianEntries: roster.entries,
    ...(record.oldValidators === undefined ? {} : { oldValidators: Object.freeze((record.oldValidators as string[]).map(item => item as `0x${string}`)) })
  });
}

function finiteTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`recovery session ${label} is invalid`);
  return value;
}

function uintString(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value); }
function bytes32(value: unknown): boolean { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value); }

function invalidTransition(stage: RecoverySessionStage, event: string): never {
  throw new Error(`recovery session cannot apply ${event} while ${stage}`);
}
