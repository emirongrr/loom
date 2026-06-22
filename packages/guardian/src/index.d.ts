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

export interface GuardianProofOfPossessionEvidence {
  leaf: Hex;
  challengeDigest: Hex;
  signature: string;
  verifierKind: "ecdsa" | "p256-webauthn" | "erc1271" | "hardware" | "institutional" | string;
  verified: boolean;
  expiresAt: number;
}

export interface GuardianEncryptedBackupEvidence {
  leaf: Hex;
  envelopeHash: Hex;
  decryptionTested: boolean;
}

export interface GuardianUsabilityProof {
  client: string;
  rootRebuilt: boolean;
  proofsVerified: boolean;
  thresholdReachable: boolean;
  backupDecryptionTested: boolean;
}

export interface GuardianPrivacyProof {
  saltedCommitments: boolean;
  publicEvidenceRedacted: boolean;
  noCentralService: boolean;
  noGuardianGraphUpload: boolean;
}

export interface GuardianOnboardingEvidence {
  version: 1;
  account?: Hex;
  chainId?: number;
  ceremonyId: Hex;
  guardianRoot: Hex;
  threshold: number;
  guardianCount: number;
  leaves: readonly {
    leaf: Hex;
    proofHash: Hex;
    challengeDigest: Hex;
    possessionVerified: boolean;
    verifierKind: string;
    backupEnvelopeHash: Hex;
    backupDecryptionTested: boolean;
  }[];
  usabilityProof: GuardianUsabilityProof;
  privacyProof: GuardianPrivacyProof;
  evidenceHash: Hex;
}

export interface ProgressiveGuardianSetupPlan {
  version: 1;
  kind: "guardian.progressiveSetup.plan";
  account: Hex;
  chainId: number;
  guardianRoot: Hex;
  guardianThreshold: number;
  guardianCount: number;
  ceremonyId: Hex;
  evidenceHash: Hex;
  delaySeconds: number;
  call: {
    target: Hex;
    value: bigint;
    data: Hex;
  };
  innerCall: {
    target: Hex;
    value: bigint;
    data: Hex;
  };
  authority: {
    risk: "guardian-setup";
    requiresUserSignature: true;
    requiresGuardianApproval: false;
    delayRequired: true;
    recoveryAvailableAfterExecution: true;
  };
  review: {
    title: string;
    risk: "guardian-setup";
    summary: string;
    warnings: readonly string[];
  };
  planHash: Hex;
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

export function buildGuardianOnboardingEvidence(input: {
  guardians: readonly GuardianInput[];
  threshold: number;
  account: Hex;
  chainId: number;
  ceremonyId?: Hex;
  proofsOfPossession: readonly GuardianProofOfPossessionEvidence[];
  encryptedBackups: readonly GuardianEncryptedBackupEvidence[];
  usabilityProof: GuardianUsabilityProof;
  privacyProof: GuardianPrivacyProof;
}): GuardianOnboardingEvidence;

export function validateGuardianOnboardingEvidence(evidence: GuardianOnboardingEvidence): true;

export function buildProgressiveGuardianSetupPlan(input: {
  account: Hex;
  chainId: number;
  currentRecoveryConfigured?: boolean;
  delaySeconds?: number;
  evidence?: GuardianOnboardingEvidence;
  guardians?: readonly GuardianInput[];
  threshold?: number;
  ceremonyId?: Hex;
  proofsOfPossession?: readonly GuardianProofOfPossessionEvidence[];
  encryptedBackups?: readonly GuardianEncryptedBackupEvidence[];
  usabilityProof?: GuardianUsabilityProof;
  privacyProof?: GuardianPrivacyProof;
}): ProgressiveGuardianSetupPlan;
