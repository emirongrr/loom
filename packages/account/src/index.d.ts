export type Hex = `0x${string}`;

export type AccountLifecycleKind =
  | "account.deploy"
  | "session.grant"
  | "session.revoke"
  | "recovery.propose"
  | "recovery.cancel"
  | "recovery.execute"
  | "migration.schedule"
  | "migration.cancel"
  | "migration.execute"
  | "vault.withdrawal.schedule"
  | "vault.withdrawal.cancel"
  | "vault.withdrawal.execute"
  | "vault.privateWithdrawal.schedule"
  | "paymaster.policy";

export interface LifecycleAuthority {
  risk:
    | "deployment"
    | "bounded-session"
    | "permission-revocation"
    | "account-recovery"
    | "account-recovery-cancellation"
    | "account-recovery-execution"
    | "account-migration"
    | "account-migration-cancellation"
    | "account-migration-execution"
    | "vault-withdrawal"
    | "vault-withdrawal-cancellation"
    | "vault-withdrawal-execution"
    | "vault-private-withdrawal"
    | "fee-policy";
  requiresUserSignature: boolean;
  requiresGuardianApproval: boolean;
  delayRequired: boolean;
  cancellable?: boolean;
  cancellableByGuardian?: boolean;
  optionalInfrastructure?: boolean;
  metadataBudgetRequired?: boolean;
  exactPendingOperationRequired?: boolean;
  cancelsPendingHighRiskOperation?: boolean;
}

export interface SessionScope {
  target: Hex;
  selector: Hex;
  token: Hex;
  maxAmount: bigint;
  validAfter: bigint;
  validUntil: bigint;
  maxUses: number;
}

export interface LifecycleIntent {
  kind: AccountLifecycleKind;
  chainId: number;
  account?: Hex;
  callData?: Hex;
  authority: LifecycleAuthority;
  [key: string]: unknown;
}

export interface AccountLifecycleClient {
  buildAccountDeployment(input: {
    chainId?: number;
    factory: Hex;
    salt: Hex;
    initCode?: Hex;
  }): LifecycleIntent;

  buildSessionGrant(input: {
    chainId?: number;
    account?: Hex;
    sessionKey: Hex;
    target: Hex;
    selector: Hex;
    token: Hex;
    maxAmount: bigint | string | number;
    validAfter?: bigint | string | number;
    validUntil: bigint | string | number;
    maxUses: number;
    callData?: Hex;
  }): LifecycleIntent;

  buildSessionRevoke(input: {
    chainId?: number;
    account?: Hex;
    sessionKey: Hex;
    callData?: Hex;
  }): LifecycleIntent;

  buildRecoveryProposal(input: {
    chainId?: number;
    account?: Hex;
    newConfigHash: Hex;
    configVersion: bigint | string | number;
    executeAfter: bigint | string | number;
    callData?: Hex;
  }): LifecycleIntent;

  buildRecoveryCancellation(input: {
    chainId?: number;
    account?: Hex;
    recoveryId: Hex;
    configVersion: bigint | string | number;
    nonce: bigint | string | number;
    route?: "account" | "guardian";
    callData?: Hex;
  }): LifecycleIntent;

  buildRecoveryExecution(input: {
    chainId?: number;
    account?: Hex;
    recoveryId: Hex;
    oldValidators: Hex[];
    newValidator: Hex;
    initDataHash: Hex;
    newGuardianRoot: Hex;
    newGuardianThreshold: number;
    executeAfter: bigint | string | number;
    expiresAt: bigint | string | number;
    callData?: Hex;
  }): LifecycleIntent;

  buildMigration(input: {
    chainId?: number;
    account?: Hex;
    destination: Hex;
    destinationCodeHash: Hex;
    entryPoint?: Hex;
    delaySeconds: number;
    expiry?: bigint | string | number;
    callData?: Hex;
  }): LifecycleIntent;

  buildMigrationCancellation(input: {
    chainId?: number;
    account?: Hex;
    migrationId: Hex;
    configVersion: bigint | string | number;
    nonce: bigint | string | number;
    route?: "account" | "guardian";
    callData?: Hex;
  }): LifecycleIntent;

  buildMigrationExecution(input: {
    chainId?: number;
    account?: Hex;
    migrationId: Hex;
    destination: Hex;
    destinationCodeHash: Hex;
    destinationConfigHash: Hex;
    callsHash: Hex;
    executeAfter: bigint | string | number;
    expiresAt: bigint | string | number;
    callData?: Hex;
  }): LifecycleIntent;

  buildVaultWithdrawal(input: {
    chainId?: number;
    account?: Hex;
    token: Hex;
    recipient: Hex;
    amount: bigint | string | number;
    executeAfter: bigint | string | number;
    expiry?: bigint | string | number;
    callData?: Hex;
  }): LifecycleIntent;

  buildVaultWithdrawalCancellation(input: {
    chainId?: number;
    account?: Hex;
    withdrawalId: Hex;
    configVersion: bigint | string | number;
    route?: "account" | "guardian";
    callData?: Hex;
  }): LifecycleIntent;

  buildVaultWithdrawalExecution(input: {
    chainId?: number;
    account?: Hex;
    withdrawalId: Hex;
    token: Hex;
    recipient: Hex;
    amount: bigint | string | number;
    callDataHash: Hex;
    executeAfter: bigint | string | number;
    expiresAt: bigint | string | number;
    callData?: Hex;
  }): LifecycleIntent;

  buildPrivateVaultWithdrawal(input: {
    chainId?: number;
    account?: Hex;
    token: Hex;
    recipient: Hex;
    amount: bigint | string | number;
    executeAfter: bigint | string | number;
    expiry?: bigint | string | number;
    privacyProtocol: string;
    privateOperationHash: Hex;
    metadataBudgetHash: Hex;
    callData?: Hex;
  }): LifecycleIntent;

  buildPaymasterPolicy(input: {
    chainId?: number;
    account?: Hex;
    paymaster: Hex;
    token: Hex;
    maxTokenAmount: bigint | string | number;
    validUntil: bigint | string | number;
    callData?: Hex;
  }): LifecycleIntent;
}

export class InvalidLifecycleRequestError extends Error {
  readonly details: Record<string, unknown>;
}

export function createAccountLifecycleClient(defaults?: {
  chainId?: number;
  account?: Hex;
}): AccountLifecycleClient;
