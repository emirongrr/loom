const DISCLOSING_SURFACES = new Set(["rpc", "indexer", "relayer", "prover", "bridge", "timing"]);

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
