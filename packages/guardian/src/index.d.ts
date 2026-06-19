export type Hex = `0x${string}`;

export interface GuardianInput {
  verifier: Hex;
  verifierCodeHash: Hex;
  keyCommitment: Hex;
  salt: Hex;
}

export interface GuardianLeaf extends GuardianInput {
  index: number;
  leaf: Hex;
}

export interface GuardianTree {
  root: Hex;
  leaves: readonly GuardianLeaf[];
  layers: readonly (readonly Hex[])[];
  proofFor(leaf: Hex): readonly Hex[];
}

export interface GuardianCeremony {
  version: 1;
  account?: Hex;
  chainId?: number;
  ceremonyId: Hex;
  guardianRoot: Hex;
  threshold: number;
  guardianCount: number;
  leaves: readonly GuardianLeaf[];
  proofs: readonly { leaf: Hex; proof: readonly Hex[] }[];
  evidenceHash: Hex;
}

export interface GuardianPossessionChallenge {
  account: Hex;
  chainId: number;
  ceremonyId: Hex;
  verifier: Hex;
  keyCommitment: Hex;
  leaf: Hex;
  expiresAt: number;
  digest: Hex;
  message: string;
}

export interface GuardianBackupEnvelope {
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: Hex;
  iv: Hex;
  authTag: Hex;
  ciphertext: Hex;
}

export class InvalidGuardianCeremonyError extends Error {
  readonly details: Record<string, unknown>;
}

export function guardianLeaf(input: GuardianInput): Hex;

export function buildGuardianTree(guardians: readonly GuardianInput[]): GuardianTree;

export function guardianProof(layers: readonly (readonly Hex[])[], leaf: Hex): readonly Hex[];

export function verifyGuardianProof(input: { root: Hex; leaf: Hex; proof: readonly Hex[] }): boolean;

export function createGuardianPossessionChallenge(
  input: GuardianInput & {
    account: Hex;
    chainId: number;
    ceremonyId: Hex;
    expiresAt: number;
  }
): GuardianPossessionChallenge;

export function buildGuardianCeremony(input: {
  guardians: readonly GuardianInput[];
  threshold: number;
  account?: Hex;
  chainId?: number;
  ceremonyId?: Hex;
}): GuardianCeremony;

export function encryptGuardianBackup(input: {
  passphrase: string;
  payload: unknown;
  salt?: Hex;
  iv?: Hex;
}): GuardianBackupEnvelope;

export function decryptGuardianBackup(input: GuardianBackupEnvelope & { passphrase: string }): unknown;
