const DISCLOSING_SURFACES = new Set(["rpc", "indexer", "relayer", "prover", "bridge", "timing"]);
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

export class ConsentRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ConsentRequiredError";
    this.details = details;
  }
}

export class MetadataBudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MetadataBudgetExceededError";
    this.details = details;
  }
}

export class PrivacyAdapterUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PrivacyAdapterUnavailableError";
    this.details = details;
  }
}

export class InvalidPrivateOperationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InvalidPrivateOperationError";
    this.details = details;
  }
}

export function providerConsentKey(profile) {
  const endpoint = profile.endpoint ?? "no-endpoint";
  return `provider:${profile.chainId}:${profile.mode}:${endpoint}`;
}

export function createConsentStore(initialKeys = []) {
  const grants = new Set(initialKeys);
  return {
    grant(key) {
      grants.add(key);
    },
    revoke(key) {
      grants.delete(key);
    },
    has(key) {
      return grants.has(key);
    },
    grantProvider(profile) {
      grants.add(providerConsentKey(profile));
    },
    hasProvider(profile) {
      return grants.has(providerConsentKey(profile));
    }
  };
}

export function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    set(key, value) {
      assertNonEmptyString(key, "storage key");
      values.set(key, String(value));
    },
    get(key) {
      assertNonEmptyString(key, "storage key");
      return values.has(key) ? values.get(key) : null;
    }
  };
}

export function createMetadataBudget(input) {
  if (!input || typeof input !== "object") throw new TypeError("metadata budget must be an object");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new TypeError("metadata budget chainId must be positive");
  if (!Array.isArray(input.items)) throw new TypeError("metadata budget items must be an array");

  return {
    protocol: input.protocol,
    chainId: input.chainId,
    degradedMode: input.degradedMode,
    items: Object.freeze(input.items.map(item => normalizeBudgetItem(item)))
  };
}

export function createProviderProfile(input) {
  if (!input || typeof input !== "object") throw new TypeError("provider profile must be an object");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new TypeError("provider profile chainId must be positive");
  if (!input.mode) throw new TypeError("provider profile mode is required");
  if (input.endpoint !== undefined) new URL(input.endpoint);

  return Object.freeze({
    mode: input.mode,
    chainId: input.chainId,
    endpoint: input.endpoint,
    verified: Boolean(input.verified),
    metadataBudget: createMetadataBudget(input.metadataBudget)
  });
}

export function assertMetadataBudgetAllowed(budget, policy = {}) {
  const allowedSurfaces = new Set(policy.allowedSurfaces ?? []);
  const requireKnownMitigation = Boolean(policy.requireKnownMitigation);

  for (const item of budget.items) {
    if (item.required && allowedSurfaces.size !== 0 && !allowedSurfaces.has(item.surface)) {
      throw new MetadataBudgetExceededError("metadata surface is outside the allowed budget", {
        surface: item.surface,
        reveals: item.reveals
      });
    }

    if (requireKnownMitigation && DISCLOSING_SURFACES.has(item.surface) && !item.mitigation) {
      throw new MetadataBudgetExceededError("disclosing metadata surface requires a mitigation", {
        surface: item.surface,
        reveals: item.reveals
      });
    }
  }
}

export function createKohakuHost(options) {
  if (!options || typeof options !== "object") throw new TypeError("host options are required");

  const profile = createProviderProfile(options.providerProfile);
  const consentStore = options.consentStore ?? createConsentStore();
  const metadataPolicy = options.metadataPolicy ?? {};
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");

  const storage = options.storage ?? createMemoryStorage();
  const keystore = options.keystore ?? rejectingKeystore();

  function assertProviderReady() {
    assertMetadataBudgetAllowed(profile.metadataBudget, metadataPolicy);
    if (!consentStore.hasProvider(profile)) {
      throw new ConsentRequiredError("provider access requires explicit user consent", {
        consentKey: providerConsentKey(profile),
        mode: profile.mode,
        chainId: profile.chainId
      });
    }
  }

  async function guardedFetch(input, init) {
    assertProviderReady();
    return fetchImpl(input, init);
  }

  return Object.freeze({
    network: Object.freeze({
      fetch: guardedFetch
    }),
    storage,
    keystore,
    provider: Object.freeze({
      profile,
      request: guardedFetch
    }),
    async metadataBudget(context) {
      if (context && context.chainId !== undefined && context.chainId !== profile.chainId) {
        throw new MetadataBudgetExceededError("privacy context chain does not match provider profile", {
          contextChainId: context.chainId,
          profileChainId: profile.chainId
        });
      }
      assertMetadataBudgetAllowed(profile.metadataBudget, metadataPolicy);
      return profile.metadataBudget;
    }
  });
}

export function createPrivateScanStateStore(storage = createMemoryStorage()) {
  return Object.freeze({
    key(context, protocol) {
      return privateScanStateKey(context, protocol);
    },
    get(context, protocol) {
      const value = storage.get(privateScanStateKey(context, protocol));
      return value === null ? null : JSON.parse(value);
    },
    set(context, protocol, state) {
      if (!state || typeof state !== "object") throw new TypeError("scan state must be an object");
      const normalized = {
        protocol: normalizeProtocol(protocol),
        chainId: normalizeChainId(context.chainId),
        account: normalizeHex(context.account, "privacy context account").toLowerCase(),
        applicationId: context.applicationId,
        scanScope: context.scanScope,
        fromBlock: state.fromBlock === undefined ? undefined : normalizeBigIntString(state.fromBlock, "fromBlock"),
        toBlock: normalizeBigIntString(state.toBlock, "toBlock"),
        latestMerkleRoot:
          state.latestMerkleRoot === undefined ? undefined : normalizeHex(state.latestMerkleRoot, "latest merkle root")
      };
      storage.set(privateScanStateKey(context, protocol), JSON.stringify(normalized));
      return Object.freeze(normalized);
    }
  });
}

export function createKohakuShieldedPoolAdapter(options) {
  if (!options || typeof options !== "object") throw new TypeError("adapter options are required");
  const protocol = normalizeProtocol(options.protocol ?? "railgun");
  const host = options.host;
  if (!host || typeof host.metadataBudget !== "function") throw new TypeError("adapter host is required");
  const plugin = options.plugin;
  if (!plugin || typeof plugin !== "object") throw new TypeError("adapter plugin is required");

  async function metadataBudget(context) {
    return host.metadataBudget(normalizeContext(context));
  }

  async function invoke(method, request) {
    const context = normalizeContext(request.context);
    const budget = await metadataBudget(context);
    const fn = plugin[method];
    if (typeof fn !== "function") {
      throw new PrivacyAdapterUnavailableError("privacy plugin does not implement requested operation", {
        protocol,
        method
      });
    }
    const result = await fn.call(plugin, { ...request, context }, host);
    return normalizePrivateOperationResult(protocol, context.chainId, budget, result);
  }

  return Object.freeze({
    protocol,
    metadataBudget,
    async createAccount(context) {
      const normalizedContext = normalizeContext(context);
      const budget = await metadataBudget(normalizedContext);
      if (typeof plugin.createAccount !== "function") {
        throw new PrivacyAdapterUnavailableError("privacy plugin does not implement account creation", {
          protocol,
          method: "createAccount"
        });
      }
      const result = await plugin.createAccount(normalizedContext, host);
      if (!result || typeof result.shieldedAddress !== "string" || result.shieldedAddress.length === 0) {
        throw new InvalidPrivateOperationError("privacy plugin returned an invalid shielded account", { protocol });
      }
      return Object.freeze({
        shieldedAddress: result.shieldedAddress,
        metadataBudget: budget
      });
    },
    buildOperation(request) {
      return invoke("prepareTransfer", request);
    },
    shield(request) {
      return invoke("prepareShield", request);
    },
    unshield(request) {
      return invoke("prepareUnshield", request);
    },
    privateTransfer(request) {
      return invoke("prepareTransfer", request);
    },
    async broadcastPrivateOperation(context, operation) {
      const normalizedContext = normalizeContext(context);
      const budget = await metadataBudget(normalizedContext);
      if (typeof plugin.broadcastPrivateOperation !== "function") {
        throw new PrivacyAdapterUnavailableError("privacy plugin does not implement private broadcast", {
          protocol,
          method: "broadcastPrivateOperation"
        });
      }
      const result = await plugin.broadcastPrivateOperation(operation, host);
      return Object.freeze({
        protocol,
        chainId: normalizedContext.chainId,
        metadataBudget: budget,
        result
      });
    }
  });
}

function normalizeBudgetItem(item) {
  if (!item || typeof item !== "object") throw new TypeError("metadata budget item must be an object");
  assertNonEmptyString(item.surface, "metadata surface");
  assertNonEmptyString(item.reveals, "metadata reveal description");
  return Object.freeze({
    surface: item.surface,
    reveals: item.reveals,
    required: Boolean(item.required),
    mitigation: item.mitigation
  });
}

function normalizePrivateOperationResult(protocol, chainId, metadataBudget, result) {
  if (!result || typeof result !== "object") {
    throw new InvalidPrivateOperationError("privacy plugin returned an invalid operation", { protocol });
  }
  return Object.freeze({
    protocol,
    chainId,
    calls: Object.freeze((result.calls ?? []).map(call => normalizeCall(call))),
    metadataBudget,
    operation: result.operation ?? result,
    requiresVaultDelay: Boolean(result.requiresVaultDelay),
    requiresBridgeFinality: result.requiresBridgeFinality
  });
}

function normalizeCall(call) {
  if (!call || typeof call !== "object") throw new InvalidPrivateOperationError("operation call must be an object");
  return Object.freeze({
    target: normalizeAddress(call.target, "operation target"),
    value: normalizeBigInt(call.value ?? 0n, "operation value"),
    data: normalizeHex(call.data, "operation data")
  });
}

function privateScanStateKey(context, protocol) {
  const normalized = normalizeContext(context);
  const scope = [
    "privacy-scan",
    normalizeProtocol(protocol),
    normalized.chainId,
    normalized.account.toLowerCase(),
    normalized.applicationId ?? "default-app",
    normalized.scanScope ?? "default-scope"
  ];
  return scope.join(":");
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") throw new TypeError("privacy context is required");
  return Object.freeze({
    account: normalizeAddress(context.account, "privacy context account"),
    chainId: normalizeChainId(context.chainId),
    applicationId: context.applicationId,
    identityHint: context.identityHint,
    scanScope: context.scanScope
  });
}

function normalizeProtocol(protocol) {
  assertNonEmptyString(protocol, "privacy protocol");
  return protocol;
}

function normalizeChainId(chainId) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError("chainId must be a positive safe integer");
  return chainId;
}

function normalizeAddress(value, label) {
  const hex = normalizeHex(value, label);
  if (hex.length !== 42) throw new TypeError(`${label} must be a 20-byte address`);
  return hex;
}

function normalizeHex(value, label) {
  assertNonEmptyString(value, label);
  if (!HEX_PATTERN.test(value)) throw new TypeError(`${label} must be hex`);
  return value;
}

function normalizeBigInt(value, label) {
  try {
    const normalized = BigInt(value);
    if (normalized < 0n) throw new TypeError(`${label} must be non-negative`);
    return normalized;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} must be bigint-compatible`);
  }
}

function normalizeBigIntString(value, label) {
  return normalizeBigInt(value, label).toString();
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function rejectingKeystore() {
  return Object.freeze({
    deriveAt() {
      throw new ConsentRequiredError("keystore access requires an explicit wallet implementation");
    }
  });
}
