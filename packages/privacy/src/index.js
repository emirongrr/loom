const DISCLOSING_SURFACES = new Set(["rpc", "indexer", "relayer", "prover", "bridge", "timing"]);
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const DEFAULT_FORBIDDEN_REVEAL_PATTERNS = [
  /private key/i,
  /viewing key/i,
  /scanning key/i,
  /seed phrase/i,
  /guardian salt/i,
  /account graph/i
];

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

export class PrivateScanStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PrivateScanStateError";
    this.details = details;
  }
}

export class PrivacyAdapterFailureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PrivacyAdapterFailureError";
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
    },
    delete(key) {
      assertNonEmptyString(key, "storage key");
      values.delete(key);
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
  const review = createMetadataLeakageHarness(policy).reviewBudget(budget);
  if (!review.approved) {
    throw new MetadataBudgetExceededError("metadata budget violates privacy policy", {
      violations: review.violations
    });
  }
}

export function createMetadataLeakageHarness(policy = {}) {
  const allowedSurfaces = new Set(policy.allowedSurfaces ?? []);
  const forbiddenSurfaces = new Set(policy.forbiddenSurfaces ?? []);
  const requireKnownMitigation = Boolean(policy.requireKnownMitigation);
  const maxRequiredSurfaces = policy.maxRequiredSurfaces;
  const forbiddenRevealPatterns = [
    ...DEFAULT_FORBIDDEN_REVEAL_PATTERNS,
    ...(policy.forbiddenRevealPatterns ?? [])
  ];

  return Object.freeze({
    reviewBudget(input) {
      const budget = createMetadataBudget(input);
      const violations = [];
      let requiredSurfaceCount = 0;

      for (const item of budget.items) {
        if (item.required) requiredSurfaceCount += 1;

        if (forbiddenSurfaces.has(item.surface)) {
          violations.push({
            code: "forbidden-surface",
            surface: item.surface,
            reveals: item.reveals
          });
        }

        if (item.required && allowedSurfaces.size !== 0 && !allowedSurfaces.has(item.surface)) {
          violations.push({
            code: "unapproved-required-surface",
            surface: item.surface,
            reveals: item.reveals
          });
        }

        if (requireKnownMitigation && DISCLOSING_SURFACES.has(item.surface) && !item.mitigation) {
          violations.push({
            code: "missing-mitigation",
            surface: item.surface,
            reveals: item.reveals
          });
        }

        for (const pattern of forbiddenRevealPatterns) {
          if (pattern.test(item.reveals)) {
            violations.push({
              code: "secret-reveal-description",
              surface: item.surface,
              reveals: item.reveals
            });
            break;
          }
        }
      }

      if (maxRequiredSurfaces !== undefined && requiredSurfaceCount > maxRequiredSurfaces) {
        violations.push({
          code: "too-many-required-surfaces",
          requiredSurfaceCount,
          maxRequiredSurfaces
        });
      }

      return Object.freeze({
        protocol: budget.protocol,
        chainId: budget.chainId,
        approved: violations.length === 0,
        requiredSurfaceCount,
        surfaces: Object.freeze([...new Set(budget.items.map(item => item.surface))]),
        violations: Object.freeze(violations.map(violation => Object.freeze(violation)))
      });
    },
    assertBudget(budget) {
      const review = this.reviewBudget(budget);
      if (!review.approved) {
        throw new MetadataBudgetExceededError("metadata budget violates privacy policy", {
          violations: review.violations
        });
      }
      return review;
    }
  });
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
          state.latestMerkleRoot === undefined ? undefined : normalizeHex(state.latestMerkleRoot, "latest merkle root"),
        updatedAt: state.updatedAt === undefined ? undefined : normalizePositiveInteger(state.updatedAt, "updated at")
      };
      storage.set(privateScanStateKey(context, protocol), JSON.stringify(normalized));
      return Object.freeze(normalized);
    },
    reset(context, protocol) {
      const key = privateScanStateKey(context, protocol);
      if (typeof storage.delete !== "function") {
        throw new PrivateScanStateError("scan state reset requires storage delete support", { key });
      }
      storage.delete(key);
    }
  });
}

export function createPrivateScanLifecycle(options = {}) {
  const protocol = normalizeProtocol(options.protocol ?? "railgun");
  const store = options.store ?? createPrivateScanStateStore(options.storage);
  const staleAfterMs = normalizePositiveInteger(options.staleAfterMs ?? 300000, "stale after ms");
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  return Object.freeze({
    protocol,
    checkpoint(context, state) {
      return store.set(context, protocol, {
        ...state,
        updatedAt: state.updatedAt ?? now()
      });
    },
    read(context) {
      const state = store.get(context, protocol);
      if (state === null) {
        return Object.freeze({
          status: "missing",
          state: null,
          ageMs: null,
          staleAfterMs
        });
      }
      const ageMs = state.updatedAt === undefined ? null : Math.max(0, now() - Number(state.updatedAt));
      const status = ageMs === null || ageMs > staleAfterMs ? "stale" : "fresh";
      return Object.freeze({
        status,
        state,
        ageMs,
        staleAfterMs
      });
    },
    requireFresh(context) {
      const result = this.read(context);
      if (result.status !== "fresh") {
        throw new PrivateScanStateError("private scan state is not fresh", {
          protocol,
          status: result.status,
          ageMs: result.ageMs,
          staleAfterMs
        });
      }
      return result.state;
    },
    reset(context) {
      store.reset(context, protocol);
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
    try {
      const result = await fn.call(plugin, { ...request, context }, host);
      return normalizePrivateOperationResult(protocol, context.chainId, budget, result);
    } catch (error) {
      throw classifyPrivacyAdapterFailure(protocol, method, error);
    }
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
      let result;
      try {
        result = await plugin.broadcastPrivateOperation(operation, host);
      } catch (error) {
        throw classifyPrivacyAdapterFailure(protocol, "broadcastPrivateOperation", error);
      }
      return Object.freeze({
        protocol,
        chainId: normalizedContext.chainId,
        metadataBudget: budget,
        result
      });
    }
  });
}

export async function createRailgunAdapterProfile(options) {
  if (!options || typeof options !== "object") throw new TypeError("railgun profile options are required");
  const host = options.host;
  if (!host || typeof host.metadataBudget !== "function") throw new TypeError("railgun profile host is required");
  const createPlugin = options.createPlugin ?? (await loadRailgunPluginFactory());
  if (typeof createPlugin !== "function") throw new TypeError("railgun plugin factory is required");

  const plugin = await createPlugin(host, options.config ?? {});
  const adapter = createKohakuShieldedPoolAdapter({
    protocol: "railgun",
    host,
    plugin: normalizeRailgunPlugin(plugin)
  });
  const scanState = createPrivateScanStateStore(options.storage ?? host.storage);

  async function metadataBudget(context) {
    return host.metadataBudget(normalizeContext(context));
  }

  return Object.freeze({
    protocol: "railgun",
    adapter,
    scanState,
    metadataBudget,
    createAccount: adapter.createAccount,
    shield: adapter.shield,
    privateTransfer: adapter.privateTransfer,
    unshield: adapter.unshield,
    broadcastPrivateOperation: adapter.broadcastPrivateOperation,
    async balance(context, assets) {
      const normalizedContext = normalizeContext(context);
      const budget = await metadataBudget(normalizedContext);
      if (typeof plugin.balance !== "function") {
        throw new PrivacyAdapterUnavailableError("railgun plugin does not implement balance", {
          protocol: "railgun",
          method: "balance"
        });
      }
      const balances = await plugin.balance(assets);
      return Object.freeze(
        balances.map(balance => normalizePrivateBalance("railgun", normalizedContext.chainId, budget, balance))
      );
    },
    async sync(context, state) {
      const normalizedContext = normalizeContext(context);
      const budget = await metadataBudget(normalizedContext);
      if (typeof plugin.sync !== "function") {
        throw new PrivacyAdapterUnavailableError("railgun plugin does not implement sync", {
          protocol: "railgun",
          method: "sync"
        });
      }
      let result;
      try {
        result = await plugin.sync({ context: normalizedContext, state }, host);
      } catch (error) {
        throw classifyPrivacyAdapterFailure("railgun", "sync", error);
      }
      const normalizedState = scanState.set(normalizedContext, "railgun", {
        fromBlock: result.fromBlock,
        toBlock: result.toBlock,
        latestMerkleRoot: result.latestMerkleRoot
      });
      return Object.freeze({
        ...normalizedState,
        metadataBudget: budget
      });
    }
  });
}

export async function createPrivacyPoolsAdapterProfile(options) {
  if (!options || typeof options !== "object") throw new TypeError("privacy-pools profile options are required");
  const host = options.host;
  if (!host || typeof host.metadataBudget !== "function") {
    throw new TypeError("privacy-pools profile host is required");
  }
  const createPlugin = options.createPlugin ?? (await loadPrivacyPoolsPluginFactory());
  if (typeof createPlugin !== "function") throw new TypeError("privacy-pools plugin factory is required");

  const plugin = await createPlugin(host, options.config ?? {});
  const adapter = createKohakuShieldedPoolAdapter({
    protocol: "privacy-pool",
    host,
    plugin: normalizePrivacyPoolsPlugin(plugin)
  });
  const scanState = createPrivateScanStateStore(options.storage ?? host.storage);

  async function metadataBudget(context) {
    return host.metadataBudget(normalizeContext(context));
  }

  return Object.freeze({
    protocol: "privacy-pool",
    adapter,
    scanState,
    metadataBudget,
    createAccount: adapter.createAccount,
    shield: adapter.shield,
    privateTransfer: adapter.privateTransfer,
    unshield: adapter.unshield,
    broadcastPrivateOperation: adapter.broadcastPrivateOperation,
    async sync(context, state) {
      const normalizedContext = normalizeContext(context);
      const budget = await metadataBudget(normalizedContext);
      if (typeof plugin.sync !== "function") {
        throw new PrivacyAdapterUnavailableError("privacy-pools plugin does not implement sync", {
          protocol: "privacy-pool",
          method: "sync"
        });
      }
      let result;
      try {
        result = await plugin.sync({ context: normalizedContext, state }, host);
      } catch (error) {
        throw classifyPrivacyAdapterFailure("privacy-pool", "sync", error);
      }
      const normalizedState = scanState.set(normalizedContext, "privacy-pool", {
        fromBlock: result.fromBlock,
        toBlock: result.toBlock,
        latestMerkleRoot: result.latestMerkleRoot
      });
      return Object.freeze({
        ...normalizedState,
        metadataBudget: budget
      });
    }
  });
}

export async function createAztecAdapterProfile(options) {
  if (!options || typeof options !== "object") throw new TypeError("aztec profile options are required");
  const host = options.host;
  if (!host || typeof host.metadataBudget !== "function") throw new TypeError("aztec profile host is required");
  const createPlugin = options.createPlugin ?? (await loadAztecPluginFactory());
  if (typeof createPlugin !== "function") throw new TypeError("aztec plugin factory is required");

  const plugin = await createPlugin(host, options.config ?? {});
  const adapter = createKohakuShieldedPoolAdapter({
    protocol: "aztec",
    host,
    plugin: normalizeAztecPlugin(plugin)
  });
  const scanState = createPrivateScanStateStore(options.storage ?? host.storage);

  async function metadataBudget(context) {
    return host.metadataBudget(normalizeContext(context));
  }

  return Object.freeze({
    protocol: "aztec",
    adapter,
    scanState,
    metadataBudget,
    createAccount: adapter.createAccount,
    shield: adapter.shield,
    privateTransfer: adapter.privateTransfer,
    unshield: adapter.unshield,
    broadcastPrivateOperation: adapter.broadcastPrivateOperation,
    async sync(context, state) {
      const normalizedContext = normalizeContext(context);
      const budget = await metadataBudget(normalizedContext);
      if (typeof plugin.sync !== "function") {
        throw new PrivacyAdapterUnavailableError("aztec plugin does not implement sync", {
          protocol: "aztec",
          method: "sync"
        });
      }
      let result;
      try {
        result = await plugin.sync({ context: normalizedContext, state }, host);
      } catch (error) {
        throw classifyPrivacyAdapterFailure("aztec", "sync", error);
      }
      const normalizedState = scanState.set(normalizedContext, "aztec", {
        fromBlock: result.fromBlock,
        toBlock: result.toBlock,
        latestMerkleRoot: result.latestMerkleRoot
      });
      return Object.freeze({
        ...normalizedState,
        metadataBudget: budget
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

async function loadRailgunPluginFactory() {
  try {
    const railgun = await import("@kohaku-eth/railgun");
    return railgun.createRailgunPlugin;
  } catch (error) {
    throw new PrivacyAdapterUnavailableError("railgun package is unavailable", {
      package: "@kohaku-eth/railgun",
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

async function loadPrivacyPoolsPluginFactory() {
  try {
    const privacyPools = await import("@kohaku-eth/privacy-pools");
    return (
      privacyPools.createPrivacyPoolsPlugin ??
      privacyPools.createPrivacyPoolPlugin ??
      privacyPools.createPlugin
    );
  } catch (error) {
    throw new PrivacyAdapterUnavailableError("privacy-pools package is unavailable", {
      package: "@kohaku-eth/privacy-pools",
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

async function loadAztecPluginFactory() {
  try {
    const aztec = await import("@aztec/aztec.js");
    return aztec.createAztecPlugin ?? aztec.createPlugin;
  } catch (error) {
    throw new PrivacyAdapterUnavailableError("aztec package is unavailable", {
      package: "@aztec/aztec.js",
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizeRailgunPlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw new TypeError("railgun plugin is required");
  return Object.freeze({
    ...plugin,
    createAccount: plugin.createAccount,
    prepareShield: plugin.prepareShield,
    prepareTransfer: plugin.prepareTransfer,
    prepareUnshield: plugin.prepareUnshield,
    broadcastPrivateOperation: plugin.broadcastPrivateOperation
  });
}

function normalizePrivacyPoolsPlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw new TypeError("privacy-pools plugin is required");
  return Object.freeze({
    ...plugin,
    createAccount: plugin.createAccount,
    prepareShield: plugin.prepareShield,
    prepareTransfer: plugin.prepareTransfer,
    prepareUnshield: plugin.prepareUnshield,
    broadcastPrivateOperation: plugin.broadcastPrivateOperation
  });
}

function normalizeAztecPlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw new TypeError("aztec plugin is required");
  return Object.freeze({
    ...plugin,
    createAccount: plugin.createAccount,
    prepareShield: plugin.prepareShield,
    prepareTransfer: plugin.prepareTransfer,
    prepareUnshield: plugin.prepareUnshield,
    broadcastPrivateOperation: plugin.broadcastPrivateOperation
  });
}

function classifyPrivacyAdapterFailure(protocol, method, error) {
  if (error instanceof PrivacyAdapterUnavailableError || error instanceof MetadataBudgetExceededError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const surface = inferFailureSurface(method, message);
  return new PrivacyAdapterFailureError("privacy adapter operation failed", {
    protocol,
    method,
    surface,
    recoverable: surface !== "prover",
    cause: message
  });
}

function inferFailureSurface(method, message) {
  const value = `${method} ${message}`.toLowerCase();
  if (value.includes("relayer") || value.includes("broadcast")) return "relayer";
  if (value.includes("prover") || value.includes("proof")) return "prover";
  if (value.includes("bridge") || value.includes("finality")) return "bridge";
  if (value.includes("indexer") || value.includes("sync")) return "indexer";
  if (value.includes("rpc") || value.includes("provider")) return "rpc";
  return "timing";
}

function normalizePrivateBalance(protocol, chainId, metadataBudget, balance) {
  if (!balance || typeof balance !== "object") {
    throw new InvalidPrivateOperationError("privacy plugin returned an invalid balance", { protocol });
  }
  const asset = typeof balance.asset === "string" && balance.asset.startsWith("erc20:")
    ? normalizeAddress(balance.asset.slice("erc20:".length), "balance asset")
    : normalizeAddress(balance.asset, "balance asset");
  return Object.freeze({
    protocol,
    chainId,
    asset,
    amount: normalizeBigInt(balance.amount ?? 0n, "balance amount"),
    verified: Boolean(balance.verified),
    metadataBudget
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

function normalizePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
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
