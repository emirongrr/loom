import sha3 from "js-sha3";
import { createAccountLifecycleClient, createLifecycleCallEncoder } from "@loom/account";
import {
  createConsentStore,
  createKohakuHost,
  createMemoryStorage,
  providerConsentKey
} from "@loom/privacy";

const { keccak_256 } = sha3;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

export class InvalidSdkRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InvalidSdkRequestError";
    this.details = details;
  }
}

const ACCOUNT_STATE_SELECTORS = Object.freeze({
  recoveryConfigured: selector("recoveryConfigured()"),
  guardianRoot: selector("guardianRoot()"),
  guardianThreshold: selector("guardianThreshold()"),
  configVersion: selector("configVersion()"),
  frozenUntil: selector("frozenUntil()"),
  validatorCount: selector("validatorCount()"),
  pendingMigration: selector("pendingMigration()")
});

const RECOVERY_STATE_SELECTORS = Object.freeze({
  pendingRecoveries: selector("pendingRecoveries(address)")
});

const VAULT_STATE_SELECTORS = Object.freeze({
  policies: selector("policies(address,address)")
});

const MAX_GUARDIAN_THRESHOLD = 32;
const MAX_VALIDATORS = 16;

export function createKohakuRuntime(options = {}) {
  if (options.host !== undefined) {
    assertKohakuHost(options.host);
    return freezeRuntime(options.host);
  }

  if (!options.providerProfile) {
    throw new InvalidSdkRequestError("kohaku providerProfile or host is required");
  }

  const host = createKohakuHost({
    providerProfile: options.providerProfile,
    fetch: options.fetch,
    storage: options.storage ?? createMemoryStorage(),
    keystore: options.keystore,
    consentStore: options.consentStore ?? createConsentStore(),
    metadataPolicy: options.metadataPolicy
  });

  return freezeRuntime(host);
}

export function createAppScopeManager(options = {}) {
  const defaultChainId = options.chainId === undefined ? undefined : normalizeChainId(options.chainId);
  const defaultAccount = options.account === undefined ? undefined : normalizeAddress(options.account, "account");

  return Object.freeze({
    scopeForOrigin(input) {
      const originInput = typeof input === "string" ? { origin: input } : input;
      if (!originInput || typeof originInput !== "object") {
        throw new InvalidSdkRequestError("app scope input is required");
      }
      const normalizedOrigin = normalizeOrigin(originInput.origin);
      const chainId = originInput.chainId === undefined ? defaultChainId : normalizeChainId(originInput.chainId);
      if (chainId === undefined) throw new InvalidSdkRequestError("chainId is required");
      const account =
        originInput.account === undefined
          ? defaultAccount
          : normalizeAddress(originInput.account, "account");
      const originHash = hashCanonical({
        type: "loom.app-scope",
        chainId,
        origin: normalizedOrigin
      });
      return Object.freeze({
        applicationId: `app:${originHash.slice(2, 34)}`,
        origin: normalizedOrigin,
        chainId,
        account,
        label: originInput.label
      });
    },
    bindPrivacyContext(context, scope) {
      const normalizedContext = normalizePrivacyContext(context);
      if (!scope || typeof scope !== "object" || typeof scope.applicationId !== "string") {
        throw new InvalidSdkRequestError("app scope is required");
      }
      if (scope.chainId !== normalizedContext.chainId) {
        throw new InvalidSdkRequestError("app scope chainId must match privacy context", {
          scopeChainId: scope.chainId,
          contextChainId: normalizedContext.chainId
        });
      }
      if (scope.account !== undefined && scope.account.toLowerCase() !== normalizedContext.account.toLowerCase()) {
        throw new InvalidSdkRequestError("app scope account must match privacy context");
      }
      return Object.freeze({
        ...normalizedContext,
        applicationId: scope.applicationId,
        scanScope: normalizedContext.scanScope ?? scope.applicationId
      });
    }
  });
}

export function createLoomSdk(options = {}) {
  const chainId = options.chainId === undefined ? undefined : normalizeChainId(options.chainId);
  const account = options.account === undefined ? undefined : normalizeAddress(options.account, "account");
  const lifecycle = createAccountLifecycleClient({ chainId, account });
  const encoders = createLifecycleCallEncoder();
  const kohaku = createKohakuRuntime(options.kohaku ?? {});
  const appScopes = createAppScopeManager({ chainId, account });

  return Object.freeze({
    lifecycle,
    encoders,
    kohaku,
    appScopes,
    clearSigning: Object.freeze({
      explainIntent: explainLifecycleIntent
    }),
    buildAppSessionGrant(input) {
      return buildAppSessionGrant({
        lifecycle,
        appScopes,
        ...input
      });
    },
    async preparePrivateVaultWithdrawal(input) {
      return preparePrivateVaultWithdrawal({
        lifecycle,
        appScopes,
        ...input
      });
    }
  });
}

export function createLoomClient(options = {}) {
  const chainId = normalizeChainId(options.chainId);
  const account = normalizeAddress(options.account, "account");
  const sdk = options.sdk ?? createLoomSdk({
    chainId,
    account,
    kohaku: options.kohaku
  });
  const transport = options.transport;
  const stateTransport = options.stateTransport;
  const signer = options.signer;
  const middleware = normalizeMiddleware(options.middleware ?? []);
  const submittedWalletCallIds = new Set();

  function prepareIntent(intent, overrides = {}) {
    return prepareUserOperationEnvelope({
      account,
      chainId,
      intent,
      ...overrides
    });
  }

  return Object.freeze({
    account,
    chainId,
    sdk,
    prepareDeployAccount(input) {
      const intent = sdk.lifecycle.buildAccountDeployment({
        chainId,
        factory: input.factory,
        salt: input.salt,
        initCode: input.initCode,
        recoveryStatus: input.recoveryStatus
      });
      const intentHash = hashCanonical(intent);
      return Object.freeze({
        kind: "account.deploy.prepare",
        intent,
        intentHash,
        factory: intent.factory,
        salt: intent.salt,
        initCode: intent.initCode,
        recoveryStatus: intent.recoveryStatus,
        review: explainLifecycleIntent(intent)
      });
    },
    prepareCalls(input) {
      const calls = normalizeCalls(input?.calls);
      const intent = Object.freeze({
        kind: "account.calls",
        chainId,
        account,
        calls,
        authority: Object.freeze({
          risk: input?.risk ?? "account-execution",
          requiresUserSignature: true,
          requiresGuardianApproval: false,
          delayRequired: false
        })
      });
      return Object.freeze({
        kind: "account.calls.prepare",
        intent,
        intentHash: hashCanonical(intent),
        review: explainLifecycleIntent(intent)
      });
    },
    getCapabilities(input = {}) {
      return walletGetCapabilities({
        account,
        chainId,
        address: input.address,
        chainIds: input.chainIds
      });
    },
    prepareWalletSendCalls(input) {
      const prepared = prepareWalletSendCalls({
        ...input,
        account,
        enabledChainId: chainId
      });
      if (submittedWalletCallIds.has(prepared.id)) {
        throw new InvalidSdkRequestError("wallet_sendCalls id has already been used", {
          code: -32602,
          id: prepared.id
        });
      }
      return prepared;
    },
    prepareUserOperation(prepared, overrides = {}) {
      const intent = prepared?.intent ?? prepared;
      return prepareIntent(intent, overrides);
    },
    toViemCalls(prepared) {
      return toViemCalls(prepared, { account });
    },
    async sendPreparedUserOperation(prepared, overrides = {}) {
      const selectedSigner = overrides.signer ?? signer;
      const selectedTransport = overrides.transport ?? transport;
      if (!selectedSigner || typeof selectedSigner.signUserOperation !== "function") {
        throw new InvalidSdkRequestError("send requires an explicit signer adapter");
      }
      if (!selectedTransport || typeof selectedTransport.sendUserOperation !== "function") {
        throw new InvalidSdkRequestError("send requires an explicit transport adapter");
      }
      const envelope = await applyMiddleware(this.prepareUserOperation(prepared, overrides), middleware);
      const signature = await selectedSigner.signUserOperation(envelope);
      const signedEnvelope = Object.freeze({
        ...envelope,
        userOperation: Object.freeze({
          ...envelope.userOperation,
          signature: normalizeHex(signature, "signature")
        })
      });
      return selectedTransport.sendUserOperation(signedEnvelope);
    },
    async sendCalls(input, overrides = {}) {
      const prepared = this.prepareCalls(input);
      return this.sendPreparedUserOperation(prepared, overrides);
    },
    async sendWalletCalls(input, overrides = {}) {
      const prepared = this.prepareWalletSendCalls(input);
      const sent = await this.sendPreparedUserOperation(prepared, overrides);
      submittedWalletCallIds.add(prepared.id);
      return Object.freeze({
        id: prepared.id,
        userOpHash: sent.userOpHash,
        capabilities: Object.freeze({
          atomic: Object.freeze({ status: "supported" })
        })
      });
    },
    async sendCallsAndWait(input, overrides = {}) {
      const selectedTransport = overrides.transport ?? transport;
      if (!selectedTransport || typeof selectedTransport.waitForUserOperationReceipt !== "function") {
        throw new InvalidSdkRequestError("send and wait requires transport receipt support");
      }
      const sent = await this.sendCalls(input, overrides);
      const receipt = await selectedTransport.waitForUserOperationReceipt({
        userOpHash: sent.userOpHash,
        timeoutMs: overrides.timeoutMs,
        pollIntervalMs: overrides.pollIntervalMs
      });
      return Object.freeze({
        ...sent,
        receipt
      });
    },
    async estimateCalls(input, overrides = {}) {
      const selectedTransport = overrides.transport ?? transport;
      if (!selectedTransport || typeof selectedTransport.estimateUserOperationGas !== "function") {
        throw new InvalidSdkRequestError("estimate requires transport gas estimation support");
      }
      const prepared = this.prepareCalls(input);
      const envelope = await applyMiddleware(this.prepareUserOperation(prepared, overrides), middleware);
      return selectedTransport.estimateUserOperationGas(envelope);
    },
    async waitForUserOperationReceipt(input, overrides = {}) {
      const selectedTransport = overrides.transport ?? transport;
      if (!selectedTransport || typeof selectedTransport.waitForUserOperationReceipt !== "function") {
        throw new InvalidSdkRequestError("wait requires transport receipt support");
      }
      return selectedTransport.waitForUserOperationReceipt({
        ...input,
        ...overrides
      });
    },
    async readSafetyState(input = {}) {
      const selectedTransport = input.stateTransport ?? input.transport ?? stateTransport;
      if (!selectedTransport || typeof selectedTransport.ethCall !== "function") {
        throw new InvalidSdkRequestError("account safety state requires an explicit state transport");
      }
      return readAccountSafetyState({
        chainId,
        account,
        stateTransport: selectedTransport,
        recoveryModule: input.recoveryModule,
        blockTag: input.blockTag,
        now: input.now
      });
    },
    grantSession(input) {
      const intent = sdk.buildAppSessionGrant({
        chainId,
        account,
        ...input
      });
      return Object.freeze({
        kind: "session.grant.prepare",
        intent,
        intentHash: hashCanonical(intent),
        review: intent.review
      });
    },
    revokeSession(input) {
      const intent = sdk.lifecycle.buildSessionRevoke({
        chainId,
        account,
        ...input
      });
      return preparedLifecycle("session.revoke.prepare", intent);
    },
    proposeRecovery(input) {
      const intent = sdk.lifecycle.buildRecoveryProposal({
        chainId,
        account,
        ...input
      });
      return preparedLifecycle("recovery.propose.prepare", intent);
    },
    cancelRecovery(input) {
      const intent = sdk.lifecycle.buildRecoveryCancellation({
        chainId,
        account,
        ...input
      });
      return preparedLifecycle("recovery.cancel.prepare", intent);
    },
    executeRecovery(input) {
      const intent = sdk.lifecycle.buildRecoveryExecution({
        chainId,
        account,
        ...input
      });
      return preparedLifecycle("recovery.execute.prepare", intent);
    },
    scheduleVaultWithdrawal(input) {
      const intent = sdk.lifecycle.buildVaultWithdrawal({
        chainId,
        account,
        ...input
      });
      return preparedLifecycle("vault.withdrawal.schedule.prepare", intent);
    },
    async preparePrivateVaultWithdrawal(input) {
      return sdk.preparePrivateVaultWithdrawal({
        context: { account, chainId, ...(input.context ?? {}) },
        ...input
      });
    }
  });
}

export function createBundlerTransport(options = {}) {
  if (!options.endpoint) throw new InvalidSdkRequestError("bundler endpoint is required");
  new URL(options.endpoint);
  const endpoint = options.endpoint;
  const entryPoint = normalizeAddress(options.entryPoint, "entry point");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = normalizePositiveInteger(options.pollIntervalMs ?? 2000, "poll interval ms");
  if (typeof fetchImpl !== "function") throw new InvalidSdkRequestError("bundler transport requires fetch");

  async function request(method, params) {
    const body = {
      jsonrpc: "2.0",
      id: options.requestId ?? 1,
      method,
      params
    };
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {})
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (payload.error) {
      throw new InvalidSdkRequestError("bundler rpc request failed", {
        method,
        code: payload.error.code,
        message: payload.error.message
      });
    }
    return payload.result;
  }

  return Object.freeze({
    endpoint,
    entryPoint,
    async sendUserOperation(envelope) {
      const normalizedEnvelope = normalizeUserOperationEnvelope(envelope);
      const result = await request("eth_sendUserOperation", [
        serializeUserOperation(normalizedEnvelope.userOperation),
        entryPoint
      ]);
      const userOpHash = normalizeBytes32(result, "userOpHash");
      return Object.freeze({
        userOpHash,
        response: result
      });
    },
    async estimateUserOperationGas(envelope) {
      const normalizedEnvelope = normalizeUserOperationEnvelope(envelope);
      const result = await request("eth_estimateUserOperationGas", [
        serializeUserOperation(normalizedEnvelope.userOperation),
        entryPoint
      ]);
      if (!result || typeof result !== "object") {
        throw new InvalidSdkRequestError("bundler returned invalid gas estimate");
      }
      return Object.freeze({
        callGasLimit: parseRpcQuantity(result.callGasLimit, "callGasLimit"),
        verificationGasLimit: parseRpcQuantity(result.verificationGasLimit, "verificationGasLimit"),
        preVerificationGas: parseRpcQuantity(result.preVerificationGas, "preVerificationGas")
      });
    },
    async getUserOperationReceipt(input) {
      const userOpHash = normalizeBytes32(input?.userOpHash, "userOpHash");
      const result = await request("eth_getUserOperationReceipt", [userOpHash]);
      return result === null ? null : normalizeUserOperationReceipt(result);
    },
    async waitForUserOperationReceipt(input) {
      const userOpHash = normalizeBytes32(input?.userOpHash, "userOpHash");
      const timeoutMs = normalizePositiveInteger(input?.timeoutMs ?? 60000, "timeout ms");
      const intervalMs = normalizePositiveInteger(input?.pollIntervalMs ?? pollIntervalMs, "poll interval ms");
      const started = Date.now();
      while (Date.now() - started <= timeoutMs) {
        const receipt = await this.getUserOperationReceipt({ userOpHash });
        if (receipt !== null) return receipt;
        await sleep(intervalMs);
      }
      throw new InvalidSdkRequestError("user operation receipt wait timed out", {
        userOpHash,
        timeoutMs
      });
    }
  });
}

export function createRpcStateTransport(options = {}) {
  if (!options.endpoint) throw new InvalidSdkRequestError("state rpc endpoint is required");
  new URL(options.endpoint);
  const endpoint = options.endpoint;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new InvalidSdkRequestError("state transport requires fetch");

  async function request(method, params) {
    const body = {
      jsonrpc: "2.0",
      id: options.requestId ?? 1,
      method,
      params
    };
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {})
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (payload.error) {
      throw new InvalidSdkRequestError("state rpc request failed", {
        method,
        code: payload.error.code,
        message: payload.error.message
      });
    }
    if (typeof payload.result !== "string" || !HEX_PATTERN.test(payload.result)) {
      throw new InvalidSdkRequestError("state rpc returned malformed hex", { method });
    }
    return payload.result;
  }

  return Object.freeze({
    endpoint,
    async ethCall(input) {
      if (!input || typeof input !== "object") throw new InvalidSdkRequestError("ethCall input is required");
      const to = normalizeAddress(input.to, "eth_call target");
      const data = normalizeHex(input.data, "eth_call data");
      const blockTag = normalizeBlockTag(input.blockTag ?? "latest");
      return request("eth_call", [{ to, data }, blockTag]);
    },
    async getCode(input) {
      if (!input || typeof input !== "object") throw new InvalidSdkRequestError("getCode input is required");
      const address = normalizeAddress(input.address, "code address");
      const blockTag = normalizeBlockTag(input.blockTag ?? "latest");
      return request("eth_getCode", [address, blockTag]);
    }
  });
}

export function createEip1193StateTransport(options = {}) {
  const provider = options.provider;
  if (!provider || typeof provider.request !== "function") {
    throw new InvalidSdkRequestError("EIP-1193 state transport requires a provider");
  }
  const profile = normalizeVerificationProfile(options.verification);

  async function request(method, params) {
    const result = await provider.request({ method, params });
    if (typeof result !== "string" || !HEX_PATTERN.test(result)) {
      throw new InvalidSdkRequestError("EIP-1193 provider returned malformed hex", {
        method,
        verified: profile.status === "verified"
      });
    }
    return result;
  }

  return Object.freeze({
    provider,
    verification: profile,
    async ethCall(input) {
      if (!input || typeof input !== "object") throw new InvalidSdkRequestError("ethCall input is required");
      const to = normalizeAddress(input.to, "eth_call target");
      const data = normalizeHex(input.data, "eth_call data");
      const blockTag = normalizeBlockTag(input.blockTag ?? profile.blockTag ?? "safe");
      return request("eth_call", [{ to, data }, blockTag]);
    },
    async getCode(input) {
      if (!input || typeof input !== "object") throw new InvalidSdkRequestError("getCode input is required");
      const address = normalizeAddress(input.address, "code address");
      const blockTag = normalizeBlockTag(input.blockTag ?? profile.blockTag ?? "safe");
      return request("eth_getCode", [address, blockTag]);
    },
    describeVerification() {
      return profile;
    }
  });
}

export function verified(value, profile) {
  const verification = normalizeVerificationProfile({ ...(profile ?? {}), status: "verified" });
  return deepFreeze({
    status: "verified",
    value,
    verification
  });
}

export function unverified(reason, value, profile = {}) {
  assertNonEmptyString(reason, "unverified reason");
  return deepFreeze({
    status: "unverified",
    value,
    reason,
    verification: normalizeVerificationProfile({ ...profile, status: "unverified" })
  });
}

export async function readAccountSafetyState(input = {}) {
  const chainId = normalizeChainId(input.chainId);
  const account = normalizeAddress(input.account, "account");
  const transport = input.stateTransport ?? input.transport;
  if (!transport || typeof transport.ethCall !== "function") {
    throw new InvalidSdkRequestError("account safety state requires an explicit state transport");
  }
  const blockTag = normalizeBlockTag(input.blockTag ?? "latest");
  const now = input.now === undefined ? undefined : normalizeBigInt(input.now, "current timestamp");

  const callAccount = selectorData =>
    transport.ethCall({ to: account, data: selectorData, blockTag });
  const [
    recoveryConfiguredResult,
    guardianRootResult,
    guardianThresholdResult,
    configVersionResult,
    frozenUntilResult,
    validatorCountResult,
    pendingMigrationResult
  ] = await Promise.all([
    callAccount(ACCOUNT_STATE_SELECTORS.recoveryConfigured),
    callAccount(ACCOUNT_STATE_SELECTORS.guardianRoot),
    callAccount(ACCOUNT_STATE_SELECTORS.guardianThreshold),
    callAccount(ACCOUNT_STATE_SELECTORS.configVersion),
    callAccount(ACCOUNT_STATE_SELECTORS.frozenUntil),
    callAccount(ACCOUNT_STATE_SELECTORS.validatorCount),
    callAccount(ACCOUNT_STATE_SELECTORS.pendingMigration)
  ]);

  const recoveryConfigured = decodeBool(recoveryConfiguredResult, "recoveryConfigured");
  const guardianRoot = decodeBytes32(guardianRootResult, "guardianRoot");
  const guardianThreshold = Number(decodeUint(guardianThresholdResult, "guardianThreshold"));
  const configVersion = decodeUint(configVersionResult, "configVersion");
  const frozenUntil = decodeUint(frozenUntilResult, "frozenUntil");
  const validatorCount = decodeUint(validatorCountResult, "validatorCount");
  const pendingMigration = decodePendingMigration(pendingMigrationResult);

  assertGuardianConfigConsistency({
    recoveryConfigured,
    guardianRoot,
    guardianThreshold
  });
  if (validatorCount === 0n) {
    throw new InvalidSdkRequestError("account safety state is invalid: validator count is zero");
  }
  if (validatorCount > BigInt(MAX_VALIDATORS)) {
    throw new InvalidSdkRequestError("account safety state is invalid: validator count exceeds max");
  }

  const recoveryModule =
    input.recoveryModule === undefined ? undefined : normalizeAddress(input.recoveryModule, "recovery module");
  const recoveryStateReadable = recoveryModule !== undefined;
  const pendingRecovery = recoveryModule === undefined
    ? undefined
    : decodePendingRecovery(await transport.ethCall({
        to: recoveryModule,
        data: `${RECOVERY_STATE_SELECTORS.pendingRecoveries}${encodeAddressArgument(account)}`,
        blockTag
      }));
  validatePendingMigration(pendingMigration);
  if (pendingRecovery !== undefined) validatePendingRecovery(pendingRecovery);

  const freeze = Object.freeze({
    frozenUntil,
    active: now === undefined ? frozenUntil !== 0n : frozenUntil > now
  });
  const pending = Object.freeze({
    recovery: pendingRecovery,
    migration: pendingMigration
  });
  const warnings = accountSafetyWarnings({
    recoveryConfigured,
    recoveryStateReadable,
    freeze,
    pendingRecovery,
    pendingMigration
  });
  const status = accountSafetyStatus({
    recoveryConfigured,
    freeze,
    pendingRecovery,
    pendingMigration
  });

  return deepFreeze({
    kind: "account.safetyState",
    chainId,
    account,
    blockTag,
    status,
    recoveryConfigured,
    config: {
      guardianRoot,
      guardianThreshold,
      configVersion,
      validatorCount
    },
    freeze,
    pending,
    coverage: {
      account: true,
      migration: true,
      recovery: recoveryStateReadable,
      ...(recoveryModule === undefined ? {} : { recoveryModule })
    },
    warnings,
    review: {
      title: "Loom account safety state",
      risk: status,
      summary: warnings[0] ?? "Guardian recovery is configured and no emergency state is pending.",
      warnings
    }
  });
}

export async function readVaultPolicyState(input = {}) {
  const account = normalizeAddress(input.account, "account");
  const vaultHook = normalizeAddress(input.vaultHook, "vault hook");
  const token = normalizeAddress(input.token, "token");
  const transport = input.stateTransport ?? input.transport;
  if (!transport || typeof transport.ethCall !== "function") {
    throw new InvalidSdkRequestError("vault policy state requires an explicit state transport");
  }
  const blockTag = normalizeBlockTag(input.blockTag ?? "latest");
  const data = `${VAULT_STATE_SELECTORS.policies}${encodeAddressArgument(account)}${encodeAddressArgument(token)}`;
  const result = await transport.ethCall({ to: vaultHook, data, blockTag });
  const words = abiWords(result, "vaultHook.policies", 4);
  return Object.freeze({
    dailyLimit: BigInt(`0x${words[0]}`),
    period: BigInt(`0x${words[1]}`),
    delay: BigInt(`0x${words[2]}`),
    enabled: BigInt(`0x${words[3]}`) === 1n
  });
}

export function toViemCalls(prepared, options = {}) {
  const intent = prepared?.intent ?? prepared;
  if (!intent || typeof intent !== "object") throw new InvalidSdkRequestError("prepared intent is required");
  if (intent.kind === "account.calls") {
    return Object.freeze(intent.calls.map(call => Object.freeze({
      to: call.target,
      value: call.value,
      data: call.data
    })));
  }
  const to = normalizeAddress(options.account ?? intent.account, "account");
  const data = normalizeHex(intent.callData, "callData");
  return Object.freeze([Object.freeze({ to, value: 0n, data })]);
}

export function walletGetCapabilities(input = {}) {
  const account = normalizeAddress(input.account, "account");
  const chainId = normalizeChainId(input.chainId);
  if (input.address !== undefined && normalizeAddress(input.address, "capability address") !== account) {
    return Object.freeze({});
  }
  const requestedChains = input.chainIds === undefined
    ? [chainId]
    : input.chainIds.map(parseCapabilityChainId);
  const output = {};
  for (const requested of requestedChains) {
    if (requested !== chainId) continue;
    output[toRpcChainId(requested)] = Object.freeze({
      atomic: Object.freeze({ status: "supported" })
    });
  }
  return Object.freeze(output);
}

export function prepareWalletSendCalls(input = {}) {
  const account = normalizeAddress(input.account, "account");
  const chainId = normalizeChainId(input.enabledChainId ?? input.localChainId ?? input.chainId);
  if (input.version !== undefined && input.version !== "2.0.0") {
    throw new InvalidSdkRequestError("unsupported wallet_sendCalls version", {
      code: -32602,
      version: input.version
    });
  }
  if (input.from !== undefined && normalizeAddress(input.from, "wallet_sendCalls from") !== account) {
    throw new InvalidSdkRequestError("wallet_sendCalls from does not match enabled account", {
      code: 4100
    });
  }
  const requestedChainId = parseRpcChainId(
    input.requestChainId ?? input.chainIdHex ?? input.walletChainId ?? (
      typeof input.chainId === "string" ? input.chainId : toRpcChainId(chainId)
    )
  );
  if (requestedChainId !== chainId) {
    throw new InvalidSdkRequestError("wallet_sendCalls chainId is not enabled", {
      code: 4100,
      chainId: toRpcChainId(requestedChainId)
    });
  }
  const atomicRequired = input.atomicRequired !== false;
  if (atomicRequired !== true && atomicRequired !== false) {
    throw new InvalidSdkRequestError("wallet_sendCalls atomicRequired must be boolean", { code: -32602 });
  }
  rejectUnsupportedCapabilities(input.capabilities);
  const calls = normalizeWalletCalls(input.calls);
  for (const call of calls) rejectUnsupportedCapabilities(call.capabilities);
  const intent = Object.freeze({
    kind: "account.calls",
    chainId,
    account,
    calls: Object.freeze(calls.map(call => Object.freeze({
      target: call.target,
      value: call.value,
      data: call.data
    }))),
    authority: Object.freeze({
      risk: "wallet-sendCalls",
      requiresUserSignature: true,
      requiresGuardianApproval: false,
      delayRequired: false
    })
  });
  const id = input.id === undefined
    ? hashCanonical({ type: "loom.wallet_sendCalls", chainId, account, calls, atomicRequired })
    : normalizeWalletCallId(input.id);
  return Object.freeze({
    kind: "wallet_sendCalls.prepare",
    version: "2.0.0",
    id,
    chainId: toRpcChainId(chainId),
    atomicRequired,
    intent,
    intentHash: hashCanonical(intent),
    capabilities: Object.freeze({
      atomic: Object.freeze({ status: "supported" })
    }),
    review: explainLifecycleIntent(intent)
  });
}

export function createPasskeySigner(options = {}) {
  assertNonEmptyString(options.credentialId, "credential id");
  assertNonEmptyString(options.rpId, "rpId");
  if (typeof options.signChallenge !== "function") {
    throw new InvalidSdkRequestError("passkey signer requires signChallenge");
  }

  return Object.freeze({
    credentialId: options.credentialId,
    rpId: options.rpId,
    origin: options.origin,
    async signUserOperation(envelope) {
      const normalizedEnvelope = normalizeUserOperationEnvelope(envelope);
      const challenge = Object.freeze({
        type: "loom.passkey-user-operation",
        credentialId: options.credentialId,
        rpId: options.rpId,
        origin: options.origin,
        account: normalizedEnvelope.account,
        chainId: normalizedEnvelope.chainId,
        intentHash: normalizedEnvelope.intentHash,
        userOperationHash: hashCanonical(normalizedEnvelope.userOperation)
      });
      const assertion = await options.signChallenge(challenge);
      return hashCanonical({
        type: "loom.passkey-assertion",
        challenge,
        assertion: normalizePasskeyAssertion(assertion)
      });
    }
  });
}

export function buildAppSessionGrant(options) {
  if (!options || typeof options !== "object") {
    throw new InvalidSdkRequestError("app session grant options are required");
  }
  const lifecycle = options.lifecycle ?? createAccountLifecycleClient({
    chainId: options.chainId,
    account: options.account
  });
  const appScopes = options.appScopes ?? createAppScopeManager({
    chainId: options.chainId,
    account: options.account
  });
  const appScope = options.appScope ?? appScopes.scopeForOrigin({
    origin: options.origin,
    chainId: options.chainId,
    account: options.account,
    label: options.label
  });

  const intent = lifecycle.buildSessionGrant({
    chainId: appScope.chainId,
    account: appScope.account,
    sessionKey: options.sessionKey,
    target: options.target,
    selector: options.selector,
    token: options.token,
    maxAmount: options.maxAmount,
    validAfter: options.validAfter,
    validUntil: options.validUntil,
    maxUses: options.maxUses,
    callData: options.callData
  });
  const appBindingHash = hashCanonical({
    type: "loom.app-session",
    applicationId: appScope.applicationId,
    chainId: appScope.chainId,
    account: appScope.account,
    scope: intent.scope,
    sessionKey: intent.sessionKey
  });

  return Object.freeze({
    ...intent,
    appScope: Object.freeze({
      applicationId: appScope.applicationId,
      chainId: appScope.chainId,
      account: appScope.account,
      label: appScope.label
    }),
    appBindingHash,
    review: explainLifecycleIntent({
      ...intent,
      appScope,
      appBindingHash
    })
  });
}

export async function preparePrivateVaultWithdrawal(options) {
  if (!options || typeof options !== "object") {
    throw new InvalidSdkRequestError("private vault withdrawal options are required");
  }
  const lifecycle = options.lifecycle ?? createAccountLifecycleClient({
    chainId: options.chainId,
    account: options.account
  });
  const method = options.method ?? "privateTransfer";
  if (!["shield", "unshield", "privateTransfer", "buildOperation"].includes(method)) {
    throw new InvalidSdkRequestError("unsupported private operation method", { method });
  }

  const adapter = options.adapter;
  if (!adapter || typeof adapter[method] !== "function") {
    throw new InvalidSdkRequestError("privacy adapter does not implement requested method", { method });
  }

  const context = bindOptionalScope(options.context, options.appScope, options.appScopes);
  const request = Object.freeze({
    ...(options.privateRequest ?? {}),
    context
  });
  const operation = await adapter[method](request);
  const normalizedOperation = normalizePrivateOperation(operation);
  const metadataBudgetHash = hashCanonical(normalizedOperation.metadataBudget);
  const privateOperationHash = hashCanonical({
    protocol: normalizedOperation.protocol,
    chainId: normalizedOperation.chainId,
    calls: normalizedOperation.calls,
    operation: normalizedOperation.operation,
    requiresVaultDelay: normalizedOperation.requiresVaultDelay,
    requiresBridgeFinality: normalizedOperation.requiresBridgeFinality
  });
  const vault = options.vault;
  if (!vault || typeof vault !== "object") throw new InvalidSdkRequestError("vault request is required");

  const intent = lifecycle.buildPrivateVaultWithdrawal({
    chainId: context.chainId,
    account: context.account,
    token: vault.token,
    recipient: vault.recipient,
    amount: vault.amount,
    executeAfter: vault.executeAfter,
    expiry: vault.expiry,
    callData: vault.callData,
    privacyProtocol: normalizedOperation.protocol,
    privateOperationHash,
    metadataBudgetHash
  });

  // The intent always describes itself as a vault withdrawal (delayRequired:
  // true), but that only holds on-chain if a VaultPolicy is actually enabled
  // for this token. Caller-supplied verification is optional, matching the
  // SDK's no-network-by-default behavior; when supplied, fail closed instead
  // of returning an intent that claims vault protection it cannot prove.
  const vaultProtection = await verifyVaultProtection({ vault, context });

  return Object.freeze({
    intent,
    operation: normalizedOperation,
    vaultProtection,
    hashes: Object.freeze({
      privateOperationHash,
      metadataBudgetHash
    }),
    review: explainLifecycleIntent(intent)
  });
}

async function verifyVaultProtection({ vault, context }) {
  const transport = vault.stateTransport ?? vault.transport;
  if (!vault.hook || !transport) {
    return Object.freeze({ verified: false, reason: "no vault hook or state transport supplied" });
  }
  const policy = await readVaultPolicyState({
    account: context.account,
    vaultHook: vault.hook,
    token: vault.token,
    stateTransport: transport,
    blockTag: vault.blockTag
  });
  if (!policy.enabled) {
    throw new InvalidSdkRequestError("vault policy is not enabled for this token; withdrawal is not vault-protected", {
      account: context.account,
      vaultHook: vault.hook,
      token: vault.token
    });
  }
  return Object.freeze({ verified: true, policy });
}

export function explainLifecycleIntent(intent) {
  if (!intent || typeof intent !== "object") throw new InvalidSdkRequestError("lifecycle intent is required");
  const authority = intent.authority;
  if (!authority || typeof authority !== "object") {
    throw new InvalidSdkRequestError("lifecycle intent authority is required");
  }

  return Object.freeze({
    title: titleForKind(intent.kind),
    kind: intent.kind,
    chainId: intent.chainId,
    account: intent.account,
    risk: authority.risk,
    requiresUserSignature: Boolean(authority.requiresUserSignature),
    requiresGuardianApproval: Boolean(authority.requiresGuardianApproval),
    delayRequired: Boolean(authority.delayRequired),
    metadataBudgetRequired: Boolean(authority.metadataBudgetRequired),
    optionalInfrastructure: Boolean(authority.optionalInfrastructure),
    summary: summaryForIntent(intent)
  });
}

export function hashCanonical(value) {
  return `0x${keccak_256(canonicalStringify(value))}`;
}

export function prepareUserOperationEnvelope(input) {
  if (!input || typeof input !== "object") throw new InvalidSdkRequestError("user operation input is required");
  const chainId = normalizeChainId(input.chainId);
  const account = normalizeAddress(input.account, "account");
  const intent = input.intent;
  if (!intent || typeof intent !== "object") throw new InvalidSdkRequestError("intent is required");
  const intentHash = hashCanonical(intent);
  const callData = input.callData ?? intent.callData ?? intent.initCode ?? encodeCalls(intent.calls ?? []);
  const userOperation = Object.freeze({
    sender: account,
    nonce: normalizeBigInt(input.nonce ?? 0n, "nonce"),
    factory: input.factory ?? intent.factory,
    factoryData: input.factoryData ?? intent.initCode,
    callData: normalizeHex(callData, "callData"),
    callGasLimit: normalizeBigInt(input.callGasLimit ?? 0n, "callGasLimit"),
    verificationGasLimit: normalizeBigInt(input.verificationGasLimit ?? 0n, "verificationGasLimit"),
    preVerificationGas: normalizeBigInt(input.preVerificationGas ?? 0n, "preVerificationGas"),
    maxFeePerGas: normalizeBigInt(input.maxFeePerGas ?? 0n, "maxFeePerGas"),
    maxPriorityFeePerGas: normalizeBigInt(input.maxPriorityFeePerGas ?? 0n, "maxPriorityFeePerGas"),
    paymaster: input.paymaster === undefined ? undefined : normalizeAddress(input.paymaster, "paymaster"),
    paymasterData: input.paymasterData === undefined ? undefined : normalizeHex(input.paymasterData, "paymasterData"),
    signature: normalizeHex(input.signature ?? "0x", "signature")
  });
  return Object.freeze({
    kind: "userOperation.prepare",
    chainId,
    account,
    intent,
    intentHash,
    userOperation,
    review: explainLifecycleIntent(intent)
  });
}

function normalizeUserOperationEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new InvalidSdkRequestError("user operation envelope is required");
  }
  if (envelope.kind !== "userOperation.prepare") {
    throw new InvalidSdkRequestError("user operation envelope kind is invalid");
  }
  return Object.freeze({
    kind: "userOperation.prepare",
    chainId: normalizeChainId(envelope.chainId),
    account: normalizeAddress(envelope.account, "account"),
    intent: envelope.intent,
    intentHash: normalizeBytes32(envelope.intentHash, "intent hash"),
    userOperation: normalizePreparedUserOperation(envelope.userOperation),
    review: envelope.review
  });
}

function normalizeUserOperationReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") {
    throw new InvalidSdkRequestError("user operation receipt is invalid");
  }
  return Object.freeze({
    ...receipt,
    userOpHash: normalizeBytes32(receipt.userOpHash, "receipt userOpHash"),
    success: Boolean(receipt.success)
  });
}

function normalizePreparedUserOperation(userOperation) {
  if (!userOperation || typeof userOperation !== "object") {
    throw new InvalidSdkRequestError("user operation is required");
  }
  return Object.freeze({
    sender: normalizeAddress(userOperation.sender, "sender"),
    nonce: normalizeBigInt(userOperation.nonce, "nonce"),
    factory: userOperation.factory === undefined ? undefined : normalizeAddress(userOperation.factory, "factory"),
    factoryData: userOperation.factoryData === undefined ? undefined : normalizeHex(userOperation.factoryData, "factoryData"),
    callData: normalizeHex(userOperation.callData, "callData"),
    callGasLimit: normalizeBigInt(userOperation.callGasLimit, "callGasLimit"),
    verificationGasLimit: normalizeBigInt(userOperation.verificationGasLimit, "verificationGasLimit"),
    preVerificationGas: normalizeBigInt(userOperation.preVerificationGas, "preVerificationGas"),
    maxFeePerGas: normalizeBigInt(userOperation.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: normalizeBigInt(userOperation.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    paymaster: userOperation.paymaster === undefined ? undefined : normalizeAddress(userOperation.paymaster, "paymaster"),
    paymasterData: userOperation.paymasterData === undefined ? undefined : normalizeHex(userOperation.paymasterData, "paymasterData"),
    signature: normalizeHex(userOperation.signature, "signature")
  });
}

function serializeUserOperation(userOperation) {
  const normalized = normalizePreparedUserOperation(userOperation);
  const output = {
    sender: normalized.sender,
    nonce: toRpcQuantity(normalized.nonce),
    callData: normalized.callData,
    callGasLimit: toRpcQuantity(normalized.callGasLimit),
    verificationGasLimit: toRpcQuantity(normalized.verificationGasLimit),
    preVerificationGas: toRpcQuantity(normalized.preVerificationGas),
    maxFeePerGas: toRpcQuantity(normalized.maxFeePerGas),
    maxPriorityFeePerGas: toRpcQuantity(normalized.maxPriorityFeePerGas),
    signature: normalized.signature
  };
  if (normalized.factory !== undefined) output.factory = normalized.factory;
  if (normalized.factoryData !== undefined) output.factoryData = normalized.factoryData;
  if (normalized.paymaster !== undefined) output.paymaster = normalized.paymaster;
  if (normalized.paymasterData !== undefined) output.paymasterData = normalized.paymasterData;
  return output;
}

function normalizePasskeyAssertion(assertion) {
  if (!assertion || typeof assertion !== "object") {
    throw new InvalidSdkRequestError("passkey assertion is required");
  }
  return Object.freeze({
    authenticatorData: normalizeHex(assertion.authenticatorData, "authenticatorData"),
    clientDataJSON: normalizeHex(assertion.clientDataJSON, "clientDataJSON"),
    signature: normalizeHex(assertion.signature, "passkey signature"),
    userHandle: assertion.userHandle === undefined ? undefined : normalizeHex(assertion.userHandle, "userHandle")
  });
}

function selector(signature) {
  return `0x${keccak_256(signature).slice(0, 8)}`;
}

function normalizeBlockTag(value) {
  if (typeof value === "string") {
    if (value === "latest" || value === "safe" || value === "finalized" || value === "pending" || value === "earliest") {
      return value;
    }
    if (/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) return value;
  }
  if (typeof value === "number" || typeof value === "bigint") return toRpcQuantity(value);
  throw new InvalidSdkRequestError("blockTag must be a standard tag or rpc quantity");
}

function abiWords(result, label, expectedWords) {
  const hex = normalizeHex(result, label).slice(2);
  if (hex.length % 64 !== 0) throw new InvalidSdkRequestError(`${label} returned malformed ABI data`);
  const words = [];
  for (let offset = 0; offset < hex.length; offset += 64) {
    words.push(hex.slice(offset, offset + 64));
  }
  if (expectedWords !== undefined && words.length !== expectedWords) {
    throw new InvalidSdkRequestError(`${label} returned unexpected ABI word count`, {
      expectedWords,
      actualWords: words.length
    });
  }
  return words;
}

function decodeUint(result, label) {
  return BigInt(`0x${abiWords(result, label, 1)[0]}`);
}

function decodeBool(result, label) {
  const value = decodeUint(result, label);
  if (value !== 0n && value !== 1n) throw new InvalidSdkRequestError(`${label} returned malformed bool`);
  return value === 1n;
}

function decodeBytes32(result, label) {
  return normalizeBytes32(`0x${abiWords(result, label, 1)[0]}`, label);
}

function decodeAddressWord(word, label) {
  const prefix = word.slice(0, 24);
  if (!/^0+$/.test(prefix)) throw new InvalidSdkRequestError(`${label} returned malformed address`);
  return normalizeAddress(`0x${word.slice(24)}`, label);
}

function decodePendingMigration(result) {
  const words = abiWords(result, "pendingMigration", 8);
  return Object.freeze({
    active: BigInt(`0x${words[4]}`) !== 0n,
    destination: decodeAddressWord(words[0], "pendingMigration.destination"),
    destinationCodeHash: normalizeBytes32(`0x${words[1]}`, "pendingMigration.destinationCodeHash"),
    destinationConfigHash: normalizeBytes32(`0x${words[2]}`, "pendingMigration.destinationConfigHash"),
    callsHash: normalizeBytes32(`0x${words[3]}`, "pendingMigration.callsHash"),
    readyAt: BigInt(`0x${words[4]}`),
    expiresAt: BigInt(`0x${words[5]}`),
    configVersion: BigInt(`0x${words[6]}`),
    nonce: BigInt(`0x${words[7]}`)
  });
}

function decodePendingRecovery(result) {
  const words = abiWords(result, "pendingRecoveries", 9);
  return Object.freeze({
    active: BigInt(`0x${words[5]}`) !== 0n,
    oldValidatorsHash: normalizeBytes32(`0x${words[0]}`, "pendingRecovery.oldValidatorsHash"),
    newValidator: decodeAddressWord(words[1], "pendingRecovery.newValidator"),
    initDataHash: normalizeBytes32(`0x${words[2]}`, "pendingRecovery.initDataHash"),
    newGuardianRoot: normalizeBytes32(`0x${words[3]}`, "pendingRecovery.newGuardianRoot"),
    newGuardianThreshold: Number(BigInt(`0x${words[4]}`)),
    readyAt: BigInt(`0x${words[5]}`),
    expiresAt: BigInt(`0x${words[6]}`),
    configVersion: BigInt(`0x${words[7]}`),
    nonce: BigInt(`0x${words[8]}`)
  });
}

function encodeAddressArgument(address) {
  return normalizeAddress(address, "address argument").slice(2).padStart(64, "0");
}

function assertGuardianConfigConsistency({ recoveryConfigured, guardianRoot, guardianThreshold }) {
  if (!Number.isSafeInteger(guardianThreshold) || guardianThreshold < 0 || guardianThreshold > MAX_GUARDIAN_THRESHOLD) {
    throw new InvalidSdkRequestError("account safety state is invalid: guardian threshold exceeds max");
  }
  const hasRoot = guardianRoot !== `0x${"0".repeat(64)}`;
  const hasThreshold = guardianThreshold !== 0;
  if (recoveryConfigured !== (hasRoot && hasThreshold)) {
    throw new InvalidSdkRequestError("account safety state is invalid: inconsistent recoveryConfigured flag");
  }
  if (hasRoot !== hasThreshold) {
    throw new InvalidSdkRequestError("account safety state is invalid: inconsistent guardian config");
  }
}

function validatePendingMigration(pendingMigration) {
  if (!pendingMigration.active) return;
  if (pendingMigration.destination === "0x0000000000000000000000000000000000000000") {
    throw new InvalidSdkRequestError("account safety state is invalid: pending migration destination is zero");
  }
  if (pendingMigration.callsHash === `0x${"0".repeat(64)}` || pendingMigration.expiresAt <= pendingMigration.readyAt) {
    throw new InvalidSdkRequestError("account safety state is invalid: malformed pending migration");
  }
}

function validatePendingRecovery(pendingRecovery) {
  if (!pendingRecovery.active) return;
  if (
    pendingRecovery.newValidator === "0x0000000000000000000000000000000000000000"
      || pendingRecovery.initDataHash === `0x${"0".repeat(64)}`
      || pendingRecovery.newGuardianRoot === `0x${"0".repeat(64)}`
      || pendingRecovery.newGuardianThreshold === 0
      || pendingRecovery.newGuardianThreshold > MAX_GUARDIAN_THRESHOLD
      || pendingRecovery.expiresAt <= pendingRecovery.readyAt
  ) {
    throw new InvalidSdkRequestError("account safety state is invalid: malformed pending recovery");
  }
}

function accountSafetyStatus({ recoveryConfigured, freeze, pendingRecovery, pendingMigration }) {
  if (freeze.active) return "frozen";
  if (pendingRecovery?.active) return "pending-recovery";
  if (pendingMigration.active) return "pending-migration";
  return recoveryConfigured ? "guardian-protected" : "unprotected-recovery";
}

function accountSafetyWarnings({ recoveryConfigured, recoveryStateReadable, freeze, pendingRecovery, pendingMigration }) {
  const warnings = [];
  if (!recoveryConfigured) {
    warnings.push("Guardian recovery is not configured; losing the primary credential can permanently lose access.");
  }
  if (recoveryConfigured && !recoveryStateReadable) {
    warnings.push("Recovery module was not provided; pending recovery state was not read.");
  }
  if (freeze.active) {
    warnings.push("Account is frozen; ordinary execution may be blocked until the freeze expires.");
  }
  if (pendingRecovery?.active) {
    warnings.push("Recovery is pending; verify the proposal or cancel it before the execution window.");
  }
  if (pendingMigration.active) {
    warnings.push("Migration is pending; verify the destination and call hash before execution.");
  }
  return Object.freeze(warnings);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function toRpcQuantity(value) {
  const normalized = normalizeBigInt(value, "rpc quantity");
  return `0x${normalized.toString(16)}`;
}

function parseRpcQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new InvalidSdkRequestError(`${label} must be an rpc quantity`);
  }
  return BigInt(value);
}

function parseRpcChainId(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new InvalidSdkRequestError("chainId must be a 0x-prefixed quantity without leading zeroes", {
      code: -32602
    });
  }
  return normalizeChainId(Number(BigInt(value)));
}

function parseCapabilityChainId(value) {
  if (typeof value === "number") return normalizeChainId(value);
  return parseRpcChainId(value);
}

function parseOptionalRpcValue(value, label) {
  if (typeof value === "string" && value.startsWith("0x")) return parseRpcQuantity(value, label);
  return normalizeBigInt(value, label);
}

function toRpcChainId(value) {
  return `0x${normalizeChainId(value).toString(16)}`;
}

function normalizeMiddleware(middleware) {
  if (!Array.isArray(middleware)) throw new InvalidSdkRequestError("middleware must be an array");
  return Object.freeze(middleware.map((item, index) => {
    if (typeof item !== "function") throw new InvalidSdkRequestError(`middleware[${index}] must be a function`);
    return item;
  }));
}

function normalizeVerificationProfile(input = {}) {
  const status = input.status === "verified" ? "verified" : "unverified";
  const source = input.source ?? (status === "verified" ? "verified-provider" : "unverified-provider");
  assertNonEmptyString(source, "verification source");
  const blockTag = input.blockTag === undefined ? undefined : normalizeBlockTag(input.blockTag);
  const assumptions = input.assumptions === undefined ? [] : input.assumptions;
  if (!Array.isArray(assumptions) || assumptions.some(item => typeof item !== "string" || item.length === 0)) {
    throw new InvalidSdkRequestError("verification assumptions must be non-empty strings");
  }
  return Object.freeze({
    status,
    source,
    ...(blockTag === undefined ? {} : { blockTag }),
    assumptions: Object.freeze([...assumptions])
  });
}

async function applyMiddleware(envelope, middleware) {
  let current = envelope;
  for (const fn of middleware) {
    current = normalizeUserOperationEnvelope(await fn(current));
  }
  return current;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freezeRuntime(host) {
  return Object.freeze({
    host,
    providerProfile: host.provider.profile,
    providerConsentKey: providerConsentKey(host.provider.profile),
    metadataBudget: host.metadataBudget.bind(host),
    request: host.provider.request
  });
}

function assertKohakuHost(host) {
  if (!host || typeof host !== "object") throw new InvalidSdkRequestError("kohaku host is required");
  if (!host.provider || !host.provider.profile || typeof host.provider.request !== "function") {
    throw new InvalidSdkRequestError("kohaku host provider surface is invalid");
  }
  if (typeof host.metadataBudget !== "function") {
    throw new InvalidSdkRequestError("kohaku host metadataBudget function is required");
  }
}

function bindOptionalScope(context, appScope, appScopes) {
  const normalizedContext = normalizePrivacyContext(context);
  if (appScope === undefined) return normalizedContext;
  const manager = appScopes ?? createAppScopeManager({
    chainId: normalizedContext.chainId,
    account: normalizedContext.account
  });
  return manager.bindPrivacyContext(normalizedContext, appScope);
}

function normalizePrivateOperation(operation) {
  if (!operation || typeof operation !== "object") {
    throw new InvalidSdkRequestError("privacy adapter returned an invalid operation");
  }
  if (typeof operation.protocol !== "string" || operation.protocol.length === 0) {
    throw new InvalidSdkRequestError("privacy operation protocol is required");
  }
  const chainId = normalizeChainId(operation.chainId);
  if (!operation.metadataBudget || typeof operation.metadataBudget !== "object") {
    throw new InvalidSdkRequestError("privacy operation metadata budget is required");
  }
  return Object.freeze({
    protocol: operation.protocol,
    chainId,
    calls: Object.freeze((operation.calls ?? []).map(normalizeCall)),
    metadataBudget: operation.metadataBudget,
    operation: operation.operation ?? null,
    requiresVaultDelay: Boolean(operation.requiresVaultDelay),
    requiresBridgeFinality: operation.requiresBridgeFinality
  });
}

function normalizeCall(call) {
  if (!call || typeof call !== "object") throw new InvalidSdkRequestError("private operation call is required");
  return Object.freeze({
    target: normalizeAddress(call.target, "operation target"),
    value: normalizeBigInt(call.value ?? 0n, "operation value"),
    data: normalizeHex(call.data, "operation data")
  });
}

function normalizeCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new InvalidSdkRequestError("calls must be a non-empty array");
  }
  return Object.freeze(calls.map(normalizeCall));
}

function normalizeWalletCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new InvalidSdkRequestError("wallet_sendCalls calls must be a non-empty array", { code: -32602 });
  }
  return Object.freeze(calls.map((call, index) => {
    if (!call || typeof call !== "object") {
      throw new InvalidSdkRequestError(`wallet_sendCalls call ${index} is invalid`, { code: -32602 });
    }
    return Object.freeze({
      target: normalizeAddress(call.to ?? call.target, `wallet_sendCalls call ${index} target`),
      value: parseOptionalRpcValue(call.value ?? 0n, `wallet_sendCalls call ${index} value`),
      data: normalizeHex(call.data ?? "0x", `wallet_sendCalls call ${index} data`),
      capabilities: call.capabilities
    });
  }));
}

function rejectUnsupportedCapabilities(capabilities) {
  if (capabilities === undefined) return;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new InvalidSdkRequestError("capabilities must be an object", { code: -32602 });
  }
  for (const [name, value] of Object.entries(capabilities)) {
    if (name === "atomic") continue;
    if (!value || typeof value !== "object" || value.optional !== true) {
      throw new InvalidSdkRequestError("unsupported non-optional capability", {
        code: 5700,
        capability: name
      });
    }
  }
}

function normalizeWalletCallId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8194) {
    throw new InvalidSdkRequestError("wallet_sendCalls id is invalid", { code: -32602 });
  }
  return value;
}

function encodeCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return "0x";
  return hashCanonical({
    type: "loom.call-bundle",
    calls
  });
}

function preparedLifecycle(kind, intent) {
  return Object.freeze({
    kind,
    intent,
    intentHash: hashCanonical(intent),
    review: explainLifecycleIntent(intent)
  });
}

function normalizePrivacyContext(context) {
  if (!context || typeof context !== "object") throw new InvalidSdkRequestError("privacy context is required");
  return Object.freeze({
    account: normalizeAddress(context.account, "privacy context account"),
    chainId: normalizeChainId(context.chainId),
    applicationId: context.applicationId,
    identityHint: context.identityHint,
    scanScope: context.scanScope
  });
}

function titleForKind(kind) {
  const titles = {
    "account.calls": "Execute Loom account calls",
    "account.deploy": "Deploy Loom account",
    "session.grant": "Grant bounded session",
    "session.revoke": "Revoke session",
    "recovery.propose": "Propose account recovery",
    "recovery.cancel": "Cancel account recovery",
    "recovery.execute": "Execute account recovery",
    "migration.schedule": "Schedule account migration",
    "migration.cancel": "Cancel account migration",
    "migration.execute": "Execute account migration",
    "vault.withdrawal.schedule": "Schedule vault withdrawal",
    "vault.withdrawal.cancel": "Cancel vault withdrawal",
    "vault.withdrawal.execute": "Execute vault withdrawal",
    "vault.privateWithdrawal.schedule": "Schedule private vault withdrawal",
    "paymaster.policy": "Set optional paymaster policy"
  };
  return titles[kind] ?? "Review Loom operation";
}

function summaryForIntent(intent) {
  switch (intent.kind) {
    case "account.calls":
      return `Account will execute ${intent.calls.length} call(s) from ${intent.account}.`;
    case "account.deploy":
      return intent.recoveryStatus === "unprotected"
        ? "Account will be deployed without guardian recovery; losing the primary credential can permanently lose access."
        : "Account will be deployed with guardian recovery configured.";
    case "session.grant":
      return intent.appScope
        ? `App-scoped session ${intent.appBindingHash} may call ${intent.scope.selector} on ${intent.scope.target} up to ${intent.scope.maxUses} time(s).`
        : `Session may call ${intent.scope.selector} on ${intent.scope.target} up to ${intent.scope.maxUses} time(s).`;
    case "vault.privateWithdrawal.schedule":
      return `Private ${intent.privacyProtocol} vault withdrawal is bound to operation ${intent.privateOperationHash}.`;
    case "paymaster.policy":
      return `Optional paymaster ${intent.paymaster} may charge up to ${intent.maxTokenAmount} of ${intent.token}.`;
    case "migration.schedule":
      return `Migration to ${intent.destination} is delayed by ${intent.delaySeconds} second(s).`;
    default:
      return `${intent.kind} requires ${intent.authority.delayRequired ? "delayed" : "immediate"} review.`;
  }
}

function canonicalStringify(value) {
  return JSON.stringify(normalizeCanonical(value));
}

function normalizeCanonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (typeof item !== "function" && item !== undefined) output[key] = normalizeCanonical(item);
    }
    return output;
  }
  throw new InvalidSdkRequestError("value is not canonicalizable");
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidSdkRequestError("origin must be a non-empty string");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidSdkRequestError("origin must be http or https");
  }
  return url.origin.toLowerCase();
}

function normalizeChainId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidSdkRequestError("chainId must be a positive safe integer");
  }
  return value;
}

function normalizePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidSdkRequestError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeAddress(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 42) throw new InvalidSdkRequestError(`${label} must be a 20-byte address`);
  return hex;
}

function normalizeBytes32(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 66) throw new InvalidSdkRequestError(`${label} must be 32 bytes`);
  return hex;
}

function normalizeHex(value, label) {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new InvalidSdkRequestError(`${label} must be hex`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidSdkRequestError(`${label} must be a non-empty string`);
  }
}

function normalizeBigInt(value, label) {
  try {
    const normalized = BigInt(value);
    if (normalized < 0n) throw new InvalidSdkRequestError(`${label} must be non-negative`);
    return normalized;
  } catch (error) {
    if (error instanceof InvalidSdkRequestError) throw error;
    throw new InvalidSdkRequestError(`${label} must be bigint-compatible`);
  }
}
