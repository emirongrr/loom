// @loom/account — local account lifecycle builders for Loom wallet clients.
// Pure and offline: every builder validates its input, freezes its output, and
// performs no I/O. The calldata encoder hand-rolls ABI encoding and is pinned
// byte-for-byte to the contracts by test/fixtures/sdk-calldata.json and its
// Solidity differential.

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
    | "unprotected-recovery"
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
  recoveryAvailable?: boolean;
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

type Numeric = bigint | string | number;

export interface AccountLifecycleClient {
  buildAccountDeployment(input: {
    chainId?: number;
    factory: Hex;
    salt: Hex;
    initCode?: Hex;
    recoveryStatus?: "guardian-protected" | "unprotected";
  }): LifecycleIntent;

  buildSessionGrant(input: {
    chainId?: number;
    account?: Hex;
    sessionKey: Hex;
    target: Hex;
    selector: Hex;
    token: Hex;
    maxAmount: Numeric;
    validAfter?: Numeric;
    validUntil: Numeric;
    maxUses: number;
    callData?: Hex;
  }): LifecycleIntent;

  buildSessionRevoke(input: { chainId?: number; account?: Hex; sessionKey: Hex; callData?: Hex }): LifecycleIntent;

  buildRecoveryProposal(input: {
    chainId?: number;
    account?: Hex;
    newConfigHash: Hex;
    configVersion: Numeric;
    executeAfter: Numeric;
    recoveryConfigured?: boolean;
    callData?: Hex;
  }): LifecycleIntent;

  buildRecoveryCancellation(input: {
    chainId?: number;
    account?: Hex;
    recoveryId: Hex;
    configVersion: Numeric;
    nonce: Numeric;
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
    executeAfter: Numeric;
    expiresAt: Numeric;
    callData?: Hex;
  }): LifecycleIntent;

  buildMigration(input: {
    chainId?: number;
    account?: Hex;
    destination: Hex;
    destinationCodeHash: Hex;
    entryPoint?: Hex;
    delaySeconds: number;
    expiry?: Numeric;
    callData?: Hex;
  }): LifecycleIntent;

  buildMigrationCancellation(input: {
    chainId?: number;
    account?: Hex;
    migrationId: Hex;
    configVersion: Numeric;
    nonce: Numeric;
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
    executeAfter: Numeric;
    expiresAt: Numeric;
    callData?: Hex;
  }): LifecycleIntent;

  buildVaultWithdrawal(input: {
    chainId?: number;
    account?: Hex;
    token: Hex;
    recipient: Hex;
    amount: Numeric;
    executeAfter: Numeric;
    expiry?: Numeric;
    callData?: Hex;
  }): LifecycleIntent;

  buildVaultWithdrawalCancellation(input: {
    chainId?: number;
    account?: Hex;
    withdrawalId: Hex;
    configVersion: Numeric;
    route?: "account" | "guardian";
    callData?: Hex;
  }): LifecycleIntent;

  buildVaultWithdrawalExecution(input: {
    chainId?: number;
    account?: Hex;
    withdrawalId: Hex;
    token: Hex;
    recipient: Hex;
    amount: Numeric;
    callDataHash: Hex;
    executeAfter: Numeric;
    expiresAt: Numeric;
    callData?: Hex;
  }): LifecycleIntent;

  buildPrivateVaultWithdrawal(input: {
    chainId?: number;
    account?: Hex;
    token: Hex;
    recipient: Hex;
    amount: Numeric;
    executeAfter: Numeric;
    expiry?: Numeric;
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
    maxTokenAmount: Numeric;
    validUntil: Numeric;
    callData?: Hex;
  }): LifecycleIntent;
}

export interface GranularPermissionInput {
  signer: Hex;
  target: Hex;
  token: Hex;
  counterparty?: Hex;
  allowedPaymaster?: Hex;
  selector: Hex;
  maxAmountPerCall: Numeric;
  maxAmountPerUserOp: Numeric;
  validAfter?: Numeric;
  validUntil: Numeric;
  maxUses: Numeric;
  maxCallsPerUserOp?: Numeric;
}

export interface LifecycleCallEncoder {
  readonly account: {
    scheduleCall(input: { target: Hex; value?: Numeric; data?: Hex; delay: Numeric }): Hex;
    executeScheduled(input: { target: Hex; value?: Numeric; data?: Hex }): Hex;
    cancelScheduled(input: { operationId: Hex }): Hex;
    scheduleMigration(input: {
      destination: Hex;
      destinationCodeHash: Hex;
      destinationConfigHash?: Hex;
      callsHash: Hex;
      delay: Numeric;
      executionWindow: Numeric;
    }): Hex;
    cancelMigration(): Hex;
    revokeTokenAllowance(input: { token: Hex; spender: Hex }): Hex;
  };
  readonly session: {
    grantPermission(input: { permissionId: Hex; permission: GranularPermissionInput }): Hex;
    revokePermission(input: { permissionId: Hex }): Hex;
  };
  readonly vault: {
    setVaultPolicy(input: {
      asset: Hex;
      policy: { dailyLimit: Numeric; period: Numeric; delay: Numeric; enabled: boolean };
    }): Hex;
    removeVaultPolicy(input: { asset: Hex }): Hex;
    scheduleVaultWithdrawal(input: { target: Hex; value?: Numeric; callData?: Hex; executionWindow: Numeric }): Hex;
    cancelVaultWithdrawal(input: { withdrawalId: Hex }): Hex;
  };
}

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

export class InvalidLifecycleRequestError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "InvalidLifecycleRequestError";
    this.details = details;
  }
}

export function createAccountLifecycleClient(defaults: { chainId?: number; account?: Hex } = {}): AccountLifecycleClient {
  const defaultChainId = defaults.chainId === undefined ? undefined : normalizeChainId(defaults.chainId);
  const defaultAccount =
    defaults.account === undefined ? undefined : normalizeAddress(defaults.account, "default account");

  function base(input: { chainId?: number; account?: Hex } = {}) {
    const chainId = input.chainId === undefined ? defaultChainId : normalizeChainId(input.chainId);
    if (chainId === undefined) throw new InvalidLifecycleRequestError("chainId is required");
    const account = input.account === undefined ? defaultAccount : normalizeAddress(input.account, "account");
    return { chainId, account };
  }

  return Object.freeze({
    buildAccountDeployment(input) {
      const chainId = input?.chainId === undefined ? defaultChainId : normalizeChainId(input.chainId);
      if (chainId === undefined) throw new InvalidLifecycleRequestError("chainId is required");
      const recoveryStatus = normalizeRecoveryStatus(input?.recoveryStatus ?? "guardian-protected");
      return freezeIntent({
        kind: "account.deploy",
        chainId,
        factory: normalizeAddress(input?.factory, "factory"),
        salt: normalizeBytes32(input?.salt, "salt"),
        initCode: normalizeHex(input?.initCode ?? "0x", "initCode"),
        recoveryStatus,
        authority: Object.freeze({
          risk: recoveryStatus === "unprotected" ? "unprotected-recovery" : "deployment",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: false,
          recoveryAvailable: recoveryStatus === "guardian-protected"
        })
      } as LifecycleIntent);
    },
    buildSessionGrant(input) {
      const scope = normalizeSessionScope(input);
      return freezeIntent({
        kind: "session.grant",
        ...base(input),
        sessionKey: normalizeAddress(input.sessionKey, "session key"),
        scope,
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "bounded-session",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: false
        })
      } as LifecycleIntent);
    },
    buildSessionRevoke(input) {
      return freezeIntent({
        kind: "session.revoke",
        ...base(input),
        sessionKey: normalizeAddress(input.sessionKey, "session key"),
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "permission-revocation",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: false
        })
      } as LifecycleIntent);
    },
    buildRecoveryProposal(input) {
      if (input?.recoveryConfigured === false) {
        throw new InvalidLifecycleRequestError("guardian recovery is not configured for this account");
      }
      return freezeIntent({
        kind: "recovery.propose",
        ...base(input),
        newConfigHash: normalizeBytes32(input.newConfigHash, "new config hash"),
        configVersion: normalizePositiveBigInt(input.configVersion, "config version"),
        executeAfter: normalizePositiveBigInt(input.executeAfter, "execute after"),
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "account-recovery",
          requiresUserSignature: false,
          requiresGuardianApproval: true,
          delayRequired: true,
          cancellable: true
        })
      } as LifecycleIntent);
    },
    buildRecoveryCancellation(input) {
      const route = normalizeCancellationRoute(input?.route ?? "account");
      return freezeIntent({
        kind: "recovery.cancel",
        ...base(input),
        recoveryId: normalizeBytes32(input.recoveryId, "recovery id"),
        configVersion: normalizeNonNegativeBigInt(input.configVersion, "config version"),
        nonce: normalizeNonNegativeBigInt(input.nonce, "nonce"),
        route,
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: cancellationAuthority("account-recovery-cancellation", route)
      } as LifecycleIntent);
    },
    buildRecoveryExecution(input) {
      const executeAfter = normalizePositiveBigInt(input.executeAfter, "execute after");
      const expiresAt = normalizePositiveBigInt(input.expiresAt, "expires at");
      if (expiresAt <= executeAfter) throw new InvalidLifecycleRequestError("expiresAt must be after executeAfter");
      return freezeIntent({
        kind: "recovery.execute",
        ...base(input),
        recoveryId: normalizeBytes32(input.recoveryId, "recovery id"),
        oldValidators: normalizeSortedAddressArray(input.oldValidators, "old validators"),
        newValidator: normalizeAddress(input.newValidator, "new validator"),
        initDataHash: normalizeBytes32(input.initDataHash, "init data hash"),
        newGuardianRoot: normalizeBytes32(input.newGuardianRoot, "new guardian root"),
        newGuardianThreshold: normalizePositiveInteger(input.newGuardianThreshold, "new guardian threshold"),
        executeAfter,
        expiresAt,
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "account-recovery-execution",
          requiresUserSignature: false,
          requiresGuardianApproval: false,
          delayRequired: true,
          exactPendingOperationRequired: true
        })
      } as LifecycleIntent);
    },
    buildMigration(input) {
      const delaySeconds = normalizePositiveInteger(input.delaySeconds, "delay seconds");
      return freezeIntent({
        kind: "migration.schedule",
        ...base(input),
        destination: normalizeAddress(input.destination, "migration destination"),
        destinationCodeHash: normalizeBytes32(input.destinationCodeHash, "destination code hash"),
        entryPoint: input.entryPoint === undefined ? undefined : normalizeAddress(input.entryPoint, "entry point"),
        delaySeconds,
        expiry: input.expiry === undefined ? undefined : normalizePositiveBigInt(input.expiry, "expiry"),
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "account-migration",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: true,
          cancellableByGuardian: true
        })
      } as LifecycleIntent);
    },
    buildMigrationCancellation(input) {
      const route = normalizeCancellationRoute(input?.route ?? "account");
      return freezeIntent({
        kind: "migration.cancel",
        ...base(input),
        migrationId: normalizeBytes32(input.migrationId, "migration id"),
        configVersion: normalizeNonNegativeBigInt(input.configVersion, "config version"),
        nonce: normalizeNonNegativeBigInt(input.nonce, "nonce"),
        route,
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: cancellationAuthority("account-migration-cancellation", route)
      } as LifecycleIntent);
    },
    buildMigrationExecution(input) {
      const executeAfter = normalizePositiveBigInt(input.executeAfter, "execute after");
      const expiresAt = normalizePositiveBigInt(input.expiresAt, "expires at");
      if (expiresAt <= executeAfter) throw new InvalidLifecycleRequestError("expiresAt must be after executeAfter");
      return freezeIntent({
        kind: "migration.execute",
        ...base(input),
        migrationId: normalizeBytes32(input.migrationId, "migration id"),
        destination: normalizeAddress(input.destination, "migration destination"),
        destinationCodeHash: normalizeBytes32(input.destinationCodeHash, "destination code hash"),
        destinationConfigHash: normalizeBytes32(input.destinationConfigHash, "destination config hash"),
        callsHash: normalizeBytes32(input.callsHash, "calls hash"),
        executeAfter,
        expiresAt,
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "account-migration-execution",
          requiresUserSignature: false,
          requiresGuardianApproval: false,
          delayRequired: true,
          exactPendingOperationRequired: true
        })
      } as LifecycleIntent);
    },
    buildVaultWithdrawal(input) {
      return freezeIntent({
        kind: "vault.withdrawal.schedule",
        ...base(input),
        token: normalizeAddress(input.token, "token"),
        recipient: normalizeAddress(input.recipient, "recipient"),
        amount: normalizePositiveBigInt(input.amount, "amount"),
        executeAfter: normalizePositiveBigInt(input.executeAfter, "execute after"),
        expiry: input.expiry === undefined ? undefined : normalizePositiveBigInt(input.expiry, "expiry"),
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "vault-withdrawal",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: true,
          cancellable: true
        })
      } as LifecycleIntent);
    },
    buildVaultWithdrawalCancellation(input) {
      const route = normalizeCancellationRoute(input?.route ?? "account");
      return freezeIntent({
        kind: "vault.withdrawal.cancel",
        ...base(input),
        withdrawalId: normalizeBytes32(input.withdrawalId, "withdrawal id"),
        configVersion: normalizeNonNegativeBigInt(input.configVersion, "config version"),
        route,
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: cancellationAuthority("vault-withdrawal-cancellation", route)
      } as LifecycleIntent);
    },
    buildVaultWithdrawalExecution(input) {
      const executeAfter = normalizePositiveBigInt(input.executeAfter, "execute after");
      const expiresAt = normalizePositiveBigInt(input.expiresAt, "expires at");
      if (expiresAt <= executeAfter) throw new InvalidLifecycleRequestError("expiresAt must be after executeAfter");
      return freezeIntent({
        kind: "vault.withdrawal.execute",
        ...base(input),
        withdrawalId: normalizeBytes32(input.withdrawalId, "withdrawal id"),
        token: normalizeAddress(input.token, "token"),
        recipient: normalizeAddress(input.recipient, "recipient"),
        amount: normalizePositiveBigInt(input.amount, "amount"),
        callDataHash: normalizeBytes32(input.callDataHash, "call data hash"),
        executeAfter,
        expiresAt,
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "vault-withdrawal-execution",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: true,
          exactPendingOperationRequired: true
        })
      } as LifecycleIntent);
    },
    buildPrivateVaultWithdrawal(input) {
      return freezeIntent({
        kind: "vault.privateWithdrawal.schedule",
        ...base(input),
        token: normalizeAddress(input.token, "token"),
        recipient: normalizeAddress(input.recipient, "recipient"),
        amount: normalizePositiveBigInt(input.amount, "amount"),
        executeAfter: normalizePositiveBigInt(input.executeAfter, "execute after"),
        expiry: input.expiry === undefined ? undefined : normalizePositiveBigInt(input.expiry, "expiry"),
        privacyProtocol: normalizeNonEmptyString(input.privacyProtocol, "privacy protocol"),
        privateOperationHash: normalizeBytes32(input.privateOperationHash, "private operation hash"),
        metadataBudgetHash: normalizeBytes32(input.metadataBudgetHash, "metadata budget hash"),
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "vault-private-withdrawal",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: true,
          cancellable: true,
          metadataBudgetRequired: true
        })
      } as LifecycleIntent);
    },
    buildPaymasterPolicy(input) {
      return freezeIntent({
        kind: "paymaster.policy",
        ...base(input),
        paymaster: normalizeAddress(input.paymaster, "paymaster"),
        token: normalizeAddress(input.token, "token"),
        maxTokenAmount: normalizePositiveBigInt(input.maxTokenAmount, "max token amount"),
        validUntil: normalizePositiveBigInt(input.validUntil, "valid until"),
        callData: normalizeHex(input.callData ?? "0x", "callData"),
        authority: Object.freeze({
          risk: "fee-policy",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: false,
          optionalInfrastructure: true
        })
      } as LifecycleIntent);
    }
  } satisfies AccountLifecycleClient);
}

export function createLifecycleCallEncoder(): LifecycleCallEncoder {
  return Object.freeze({
    account: Object.freeze({
      scheduleCall(input) {
        return hex(
          selector("dcfe7ea7") +
            encodeTuple(
              [
                encodeAddress(input?.target, "target"),
                encodeUint(input?.value ?? 0n, "value"),
                encodeOffset(4),
                encodeUint(input?.delay, "delay")
              ],
              [encodeBytes(input?.data ?? "0x", "data")]
            )
        );
      },
      executeScheduled(input) {
        return hex(
          selector("64579bf6") +
            encodeTuple(
              [encodeAddress(input?.target, "target"), encodeUint(input?.value ?? 0n, "value"), encodeOffset(3)],
              [encodeBytes(input?.data ?? "0x", "data")]
            )
        );
      },
      cancelScheduled(input) {
        return hex(selector("14a8b2b1") + encodeBytes32(input?.operationId, "operation id"));
      },
      scheduleMigration(input) {
        return hex(
          selector("528833ca") +
            encodeWords([
              encodeAddress(input?.destination, "migration destination"),
              encodeBytes32(input?.destinationCodeHash, "destination code hash"),
              encodeBytes32(input?.destinationConfigHash ?? zeroBytes32(), "destination config hash"),
              encodeBytes32(input?.callsHash, "calls hash"),
              encodeUint(input?.delay, "delay"),
              encodeUint(input?.executionWindow, "execution window")
            ])
        );
      },
      cancelMigration() {
        return hex(selector("10639ea0"));
      },
      revokeTokenAllowance(input) {
        return hex(
          selector("bc881467") +
            encodeWords([encodeAddress(input?.token, "token"), encodeAddress(input?.spender, "spender")])
        );
      }
    }),
    session: Object.freeze({
      grantPermission(input) {
        return hex(
          selector("7d198ff1") +
            encodeWords([
              encodeBytes32(input?.permissionId, "permission id"),
              ...encodeGranularPermission(input?.permission)
            ])
        );
      },
      revokePermission(input) {
        return hex(selector("e89005c7") + encodeBytes32(input?.permissionId, "permission id"));
      }
    }),
    vault: Object.freeze({
      setVaultPolicy(input) {
        return hex(
          selector("d97a2860") +
            encodeWords([
              encodeAddress(input?.asset, "asset"),
              encodeUint(input?.policy?.dailyLimit, "daily limit"),
              encodeUint(input?.policy?.period, "period"),
              encodeUint(input?.policy?.delay, "delay"),
              encodeBool(input?.policy?.enabled, "enabled")
            ])
        );
      },
      removeVaultPolicy(input) {
        return hex(selector("15ed54ba") + encodeAddress(input?.asset, "asset"));
      },
      scheduleVaultWithdrawal(input) {
        return hex(
          selector("1bdd50c5") +
            encodeTuple(
              [
                encodeAddress(input?.target, "target"),
                encodeUint(input?.value ?? 0n, "value"),
                encodeOffset(4),
                encodeUint(input?.executionWindow, "execution window")
              ],
              [encodeBytes(input?.callData ?? "0x", "callData")]
            )
        );
      },
      cancelVaultWithdrawal(input) {
        return hex(selector("7facb463") + encodeBytes32(input?.withdrawalId, "withdrawal id"));
      }
    })
  } satisfies LifecycleCallEncoder);
}

function cancellationAuthority(
  risk: LifecycleAuthority["risk"],
  route: "account" | "guardian"
): Readonly<LifecycleAuthority> {
  return Object.freeze({
    risk,
    requiresUserSignature: route === "account",
    requiresGuardianApproval: route === "guardian",
    delayRequired: false,
    cancelsPendingHighRiskOperation: true
  });
}

function normalizeSessionScope(input: unknown): Readonly<SessionScope> {
  if (!input || typeof input !== "object") throw new InvalidLifecycleRequestError("session scope input is required");
  const scope = input as Record<string, unknown>;
  const validAfter = normalizeNonNegativeBigInt(scope.validAfter ?? 0n, "valid after");
  const validUntil = normalizePositiveBigInt(scope.validUntil, "valid until");
  if (validUntil <= validAfter) throw new InvalidLifecycleRequestError("session validUntil must be after validAfter");
  return Object.freeze({
    target: normalizeAddress(scope.target, "target"),
    selector: normalizeSelector(scope.selector, "selector"),
    token: normalizeAddress(scope.token, "token"),
    maxAmount: normalizeNonNegativeBigInt(scope.maxAmount, "max amount"),
    validAfter,
    validUntil,
    maxUses: normalizePositiveInteger(scope.maxUses, "max uses")
  });
}

function normalizeCancellationRoute(value: unknown): "account" | "guardian" {
  if (value !== "account" && value !== "guardian") {
    throw new InvalidLifecycleRequestError("cancellation route must be account or guardian");
  }
  return value;
}

function normalizeRecoveryStatus(value: unknown): "guardian-protected" | "unprotected" {
  if (value !== "guardian-protected" && value !== "unprotected") {
    throw new InvalidLifecycleRequestError("recoveryStatus must be guardian-protected or unprotected");
  }
  return value;
}

function normalizeSortedAddressArray(value: unknown, label: string): readonly Hex[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidLifecycleRequestError(`${label} must be a non-empty address array`);
  }
  const normalized = value.map((item, index) => normalizeAddress(item, `${label}[${index}]`));
  for (let i = 1; i < normalized.length; i += 1) {
    if (BigInt(normalized[i] as Hex) <= BigInt(normalized[i - 1] as Hex)) {
      throw new InvalidLifecycleRequestError(`${label} must be strictly sorted and unique`);
    }
  }
  return Object.freeze(normalized);
}

function freezeIntent(intent: LifecycleIntent): LifecycleIntent {
  return Object.freeze(intent);
}

function encodeGranularPermission(permission: unknown): string[] {
  if (!permission || typeof permission !== "object") {
    throw new InvalidLifecycleRequestError("permission is required");
  }
  const p = permission as Record<string, unknown>;
  return [
    encodeAddress(p.signer, "permission signer"),
    encodeAddress(p.target, "permission target"),
    encodeAddress(p.token, "permission token"),
    encodeAddress(p.counterparty ?? zeroAddress(), "permission counterparty"),
    encodeAddress(p.allowedPaymaster ?? zeroAddress(), "permission allowed paymaster"),
    encodeSelector(p.selector, "permission selector"),
    encodeUint(p.maxAmountPerCall, "permission max amount per call"),
    encodeUint(p.maxAmountPerUserOp, "permission max amount per user op"),
    encodeUint(p.validAfter ?? 0n, "permission valid after"),
    encodeUint(p.validUntil, "permission valid until"),
    encodeUint(p.maxUses, "permission max uses"),
    encodeUint(p.maxCallsPerUserOp ?? 1, "permission max calls per user op")
  ];
}

function encodeTuple(headWords: string[], dynamicTails: string[] = []): string {
  return encodeWords(headWords) + dynamicTails.join("");
}

function encodeWords(words: string[]): string {
  return words.join("");
}

function encodeOffset(staticWordCount: number): string {
  return encodeUint(BigInt(staticWordCount) * 32n, "offset");
}

function encodeBytes(value: unknown, label: string): string {
  const bytes = strip0x(normalizeHex(value, label));
  const length = bytes.length / 2;
  const paddedLength = Math.ceil(length / 32) * 64;
  return encodeUint(length, `${label} length`) + bytes.padEnd(paddedLength, "0");
}

function encodeAddress(value: unknown, label: string): string {
  return strip0x(normalizeAddress(value, label)).padStart(64, "0");
}

function encodeBytes32(value: unknown, label: string): string {
  return strip0x(normalizeBytes32(value, label));
}

function encodeSelector(value: unknown, label: string): string {
  return strip0x(normalizeSelector(value, label)).padEnd(64, "0");
}

function encodeUint(value: unknown, label: string): string {
  const normalized = normalizeBigInt(value, label);
  if (normalized >= 1n << 256n) throw new InvalidLifecycleRequestError(`${label} exceeds uint256`);
  return normalized.toString(16).padStart(64, "0");
}

function encodeBool(value: unknown, label: string): string {
  if (typeof value !== "boolean") throw new InvalidLifecycleRequestError(`${label} must be boolean`);
  return encodeUint(value ? 1n : 0n, label);
}

function selector(value: string): string {
  return `0x${value}`;
}

function hex(value: string): Hex {
  return value as Hex;
}

function strip0x(value: Hex): string {
  return value.slice(2);
}

function zeroAddress(): Hex {
  return "0x0000000000000000000000000000000000000000";
}

function zeroBytes32(): Hex {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function normalizeChainId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidLifecycleRequestError("chainId must be a positive safe integer");
  }
  return value as number;
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidLifecycleRequestError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function normalizePositiveBigInt(value: unknown, label: string): bigint {
  const normalized = normalizeBigInt(value, label);
  if (normalized <= 0n) throw new InvalidLifecycleRequestError(`${label} must be positive`);
  return normalized;
}

function normalizeNonNegativeBigInt(value: unknown, label: string): bigint {
  const normalized = normalizeBigInt(value, label);
  if (normalized < 0n) throw new InvalidLifecycleRequestError(`${label} must be non-negative`);
  return normalized;
}

function normalizeBigInt(value: unknown, label: string): bigint {
  try {
    return BigInt(value as string | number | bigint | boolean);
  } catch {
    throw new InvalidLifecycleRequestError(`${label} must be bigint-compatible`);
  }
}

function normalizeAddress(value: unknown, label: string): Hex {
  const normalized = normalizeHex(value, label);
  if (normalized.length !== 42) throw new InvalidLifecycleRequestError(`${label} must be a 20-byte address`);
  return normalized;
}

function normalizeBytes32(value: unknown, label: string): Hex {
  const normalized = normalizeHex(value, label);
  if (normalized.length !== 66) throw new InvalidLifecycleRequestError(`${label} must be 32 bytes`);
  return normalized;
}

function normalizeSelector(value: unknown, label: string): Hex {
  const normalized = normalizeHex(value, label);
  if (normalized.length !== 10) throw new InvalidLifecycleRequestError(`${label} must be 4 bytes`);
  return normalized;
}

function normalizeNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidLifecycleRequestError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new InvalidLifecycleRequestError(`${label} must be hex`);
  }
  return value as Hex;
}
