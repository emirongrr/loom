import type { Address, Hex } from "@loom/core";
import { createEncryptedStore, type EncryptedStore } from "../../storage/encryptedStore.ts";
import type { PreparedRecoveryPasskey } from "./recoveryPasskey.ts";
import { keccak256 } from "viem";

export interface RecoveryDraft {
  readonly version: 1;
  readonly id: string;
  readonly chainId: number;
  readonly account: Address;
  readonly configVersion: string;
  readonly label: string;
  readonly createdAt: number;
  readonly preparation: RecoveryDraftPreparation;
}

export type RecoveryDraftPreparation = Omit<PreparedRecoveryPasskey, "deploy"> & {
  readonly deploy?: Omit<NonNullable<PreparedRecoveryPasskey["deploy"]>, "value">;
};

export interface RecoveryDraftRepository {
  inspect(): Promise<{ readonly drafts: readonly RecoveryDraft[]; readonly issues: readonly string[] }>;
  write(draft: RecoveryDraft): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createRecoveryDraft(input: {
  readonly chainId: number;
  readonly account: Address;
  readonly configVersion: string;
  readonly label: string;
  readonly preparation: PreparedRecoveryPasskey;
  readonly createdAt?: number;
}): RecoveryDraft {
  const preparation: RecoveryDraftPreparation = Object.freeze({
    ...input.preparation,
    ...(input.preparation.deploy ? { deploy: Object.freeze({ to: input.preparation.deploy.to, data: input.preparation.deploy.data, permissionless: true as const }) } : {})
  });
  return parseRecoveryDraft({
    version: 1,
    id: `${input.chainId}:${input.account.toLowerCase()}:${input.preparation.validator.toLowerCase()}`,
    ...input,
    preparation,
    createdAt: input.createdAt ?? Date.now()
  });
}

export function restoreRecoveryDraftPreparation(draft: RecoveryDraft): PreparedRecoveryPasskey {
  const { deploy, ...preparation } = draft.preparation;
  return deploy
    ? Object.freeze({ ...preparation, deploy: Object.freeze({ ...deploy, value: 0n as const }) })
    : Object.freeze(preparation);
}

export function createRecoveryDraftRepository(
  store: EncryptedStore = createEncryptedStore("loom-recovery-drafts-v1")
): RecoveryDraftRepository {
  const inspect = async () => {
    const drafts: RecoveryDraft[] = [];
    const issues: string[] = [];
    for (const entry of await store.entries()) {
      if (entry.corrupt) { issues.push(entry.key); continue; }
      try {
        const draft = parseRecoveryDraft(entry.value);
        if (draft.id !== entry.key) throw new Error("draft key mismatch");
        drafts.push(draft);
      } catch { issues.push(entry.key); }
    }
    drafts.sort((left, right) => right.createdAt - left.createdAt);
    return Object.freeze({ drafts: Object.freeze(drafts), issues: Object.freeze(issues) });
  };
  return Object.freeze({
    inspect,
    async write(draft: RecoveryDraft) { const parsed = parseRecoveryDraft(draft); await store.put(parsed.id, parsed); },
    async remove(id: string) { await store.remove(id); }
  });
}

export function parseRecoveryDraft(value: unknown): RecoveryDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery draft is invalid");
  const record = value as Record<string, unknown>;
  const allowed = ["version", "id", "chainId", "account", "configVersion", "label", "createdAt", "preparation"];
  if (record.version !== 1 || Object.keys(record).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(record, key))) throw new Error("recovery draft format is invalid");
  if (typeof record.id !== "string" || record.id.length > 180 || !Number.isSafeInteger(record.chainId) || Number(record.chainId) < 1) throw new Error("recovery draft identity is invalid");
  if (!address(record.account) || typeof record.configVersion !== "string" || !/^(0|[1-9][0-9]*)$/.test(record.configVersion)) throw new Error("recovery draft chain binding is invalid");
  if (typeof record.label !== "string" || record.label.trim().length < 1 || record.label.length > 80 || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt <= 0) throw new Error("recovery draft metadata is invalid");
  const preparation = parsePreparation(record.preparation);
  const expectedId = `${record.chainId}:${String(record.account).toLowerCase()}:${preparation.validator.toLowerCase()}`;
  if (record.id !== expectedId) throw new Error("recovery draft key is invalid");
  return Object.freeze({ version: 1, id: record.id, chainId: Number(record.chainId), account: record.account as Address, configVersion: record.configVersion, label: record.label, createdAt: record.createdAt, preparation });
}

function parsePreparation(value: unknown): RecoveryDraftPreparation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery draft preparation is invalid");
  const record = value as Record<string, unknown>;
  if (!record.passkey || typeof record.passkey !== "object" || Array.isArray(record.passkey)) throw new Error("recovery draft passkey is invalid");
  const passkey = record.passkey as Record<string, unknown>;
  if (!hex(passkey.credentialId) || !passkey.publicKey || typeof passkey.publicKey !== "object" || Array.isArray(passkey.publicKey)) throw new Error("recovery draft passkey is invalid");
  const publicKey = passkey.publicKey as Record<string, unknown>;
  if (!bytes32(publicKey.x) || !bytes32(publicKey.y) || typeof record.rpId !== "string" || typeof record.origin !== "string" || !hex(record.initData) || !address(record.validator) || !bytes32(record.initDataHash) || typeof record.alreadyDeployed !== "boolean") throw new Error("recovery draft preparation is invalid");
  if (keccak256(record.initData as Hex) !== String(record.initDataHash).toLowerCase()) throw new Error("recovery draft init data hash is invalid");
  const deploy = record.deploy;
  if (deploy !== undefined && (!deploy || typeof deploy !== "object" || Array.isArray(deploy) || !address((deploy as Record<string, unknown>).to) || !hex((deploy as Record<string, unknown>).data) || Object.hasOwn(deploy as object, "value") || (deploy as Record<string, unknown>).permissionless !== true)) throw new Error("recovery draft deployment is invalid");
  const preparation = {
    passkey: Object.freeze({ credentialId: passkey.credentialId as Hex, publicKey: Object.freeze({ x: publicKey.x as Hex, y: publicKey.y as Hex }) }),
    rpId: record.rpId, origin: record.origin, initData: record.initData as Hex, validator: record.validator as Address,
    initDataHash: record.initDataHash as Hex, alreadyDeployed: record.alreadyDeployed
  };
  return deploy === undefined
    ? Object.freeze(preparation)
    : Object.freeze({ ...preparation, deploy: deploy as NonNullable<RecoveryDraftPreparation["deploy"]> });
}

function address(value: unknown): boolean { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function bytes32(value: unknown): boolean { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value); }
function hex(value: unknown): boolean { return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value); }
