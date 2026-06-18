const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

export class InvalidLifecycleRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InvalidLifecycleRequestError";
    this.details = details;
  }
}

export function createAccountLifecycleClient(defaults = {}) {
  const defaultChainId = defaults.chainId === undefined ? undefined : normalizeChainId(defaults.chainId);
  const defaultAccount = defaults.account === undefined ? undefined : normalizeAddress(defaults.account, "default account");

  function base(input = {}) {
    const chainId = input.chainId === undefined ? defaultChainId : normalizeChainId(input.chainId);
    if (chainId === undefined) throw new InvalidLifecycleRequestError("chainId is required");
    const account = input.account === undefined ? defaultAccount : normalizeAddress(input.account, "account");
    return { chainId, account };
  }

  return Object.freeze({
    buildAccountDeployment(input) {
      const chainId = input?.chainId === undefined ? defaultChainId : normalizeChainId(input.chainId);
      if (chainId === undefined) throw new InvalidLifecycleRequestError("chainId is required");
      return freezeIntent({
        kind: "account.deploy",
        chainId,
        factory: normalizeAddress(input?.factory, "factory"),
        salt: normalizeBytes32(input?.salt, "salt"),
        initCode: normalizeHex(input?.initCode ?? "0x", "initCode"),
        authority: Object.freeze({
          risk: "deployment",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: false
        })
      });
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
      });
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
      });
    },
    buildRecoveryProposal(input) {
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
    }
  });
}

function cancellationAuthority(risk, route) {
  return Object.freeze({
    risk,
    requiresUserSignature: route === "account",
    requiresGuardianApproval: route === "guardian",
    delayRequired: false,
    cancelsPendingHighRiskOperation: true
  });
}

function normalizeSessionScope(input) {
  if (!input || typeof input !== "object") throw new InvalidLifecycleRequestError("session scope input is required");
  const validAfter = normalizeNonNegativeBigInt(input.validAfter ?? 0n, "valid after");
  const validUntil = normalizePositiveBigInt(input.validUntil, "valid until");
  if (validUntil <= validAfter) throw new InvalidLifecycleRequestError("session validUntil must be after validAfter");
  return Object.freeze({
    target: normalizeAddress(input.target, "target"),
    selector: normalizeSelector(input.selector, "selector"),
    token: normalizeAddress(input.token, "token"),
    maxAmount: normalizeNonNegativeBigInt(input.maxAmount, "max amount"),
    validAfter,
    validUntil,
    maxUses: normalizePositiveInteger(input.maxUses, "max uses")
  });
}

function normalizeCancellationRoute(value) {
  if (value !== "account" && value !== "guardian") {
    throw new InvalidLifecycleRequestError("cancellation route must be account or guardian");
  }
  return value;
}

function normalizeSortedAddressArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidLifecycleRequestError(`${label} must be a non-empty address array`);
  }
  const normalized = value.map((item, index) => normalizeAddress(item, `${label}[${index}]`));
  for (let i = 1; i < normalized.length; i += 1) {
    if (BigInt(normalized[i]) <= BigInt(normalized[i - 1])) {
      throw new InvalidLifecycleRequestError(`${label} must be strictly sorted and unique`);
    }
  }
  return Object.freeze(normalized);
}

function freezeIntent(intent) {
  return Object.freeze(intent);
}

function normalizeChainId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidLifecycleRequestError("chainId must be a positive safe integer");
  }
  return value;
}

function normalizePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidLifecycleRequestError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizePositiveBigInt(value, label) {
  const normalized = normalizeBigInt(value, label);
  if (normalized <= 0n) throw new InvalidLifecycleRequestError(`${label} must be positive`);
  return normalized;
}

function normalizeNonNegativeBigInt(value, label) {
  const normalized = normalizeBigInt(value, label);
  if (normalized < 0n) throw new InvalidLifecycleRequestError(`${label} must be non-negative`);
  return normalized;
}

function normalizeBigInt(value, label) {
  try {
    return BigInt(value);
  } catch {
    throw new InvalidLifecycleRequestError(`${label} must be bigint-compatible`);
  }
}

function normalizeAddress(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 42) throw new InvalidLifecycleRequestError(`${label} must be a 20-byte address`);
  return hex;
}

function normalizeBytes32(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 66) throw new InvalidLifecycleRequestError(`${label} must be 32 bytes`);
  return hex;
}

function normalizeSelector(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 10) throw new InvalidLifecycleRequestError(`${label} must be 4 bytes`);
  return hex;
}

function normalizeNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidLifecycleRequestError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeHex(value, label) {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new InvalidLifecycleRequestError(`${label} must be hex`);
  }
  return value;
}
