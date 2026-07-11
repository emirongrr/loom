import { MobileWalletConfigurationError } from "../platform/errors";
import type { SecureLocalStore } from "../platform/secureStore";
import type { MobileWalletConfiguration } from "../types/wallet";

// Runtime infrastructure overrides.
//
// The build-time environment stays the source of truth for chain identity,
// addresses, and passkey binding — those must never be editable at runtime.
// Endpoints are different: RPC and bundler URLs are replaceable transports by
// design (any ERC-4337 bundler can be plugged in), so the settings screen may
// override them. Overrides never weaken a gate: an empty override falls back
// to the environment value, and an invalid URL is rejected before it is saved.

export interface EndpointOverrides {
  readonly bundlerUrl?: string;
  readonly rpcUrl?: string;
}

export function assertEndpointUrl(value: string, label: string): string {
  const trimmed = value.trim();
  const parsed = (() => {
    try {
      return new URL(trimmed);
    } catch {
      throw new MobileWalletConfigurationError(`${label} is not a valid URL.`);
    }
  })();
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new MobileWalletConfigurationError(`${label} must be https or localhost.`);
  }
  return trimmed;
}

export async function loadEndpointOverrides(store: SecureLocalStore): Promise<EndpointOverrides> {
  const [bundlerUrl, rpcUrl] = await Promise.all([
    store.get("loom.endpoints.bundler"),
    store.get("loom.endpoints.rpc")
  ]);
  return {
    bundlerUrl: bundlerUrl ?? undefined,
    rpcUrl: rpcUrl ?? undefined
  };
}

export async function saveEndpointOverride(
  store: SecureLocalStore,
  endpoint: "bundler" | "rpc",
  value: string
): Promise<void> {
  const key = endpoint === "bundler" ? "loom.endpoints.bundler" : "loom.endpoints.rpc";
  if (value.trim().length === 0) {
    await store.delete(key);
    return;
  }
  await store.set(key, assertEndpointUrl(value, endpoint === "bundler" ? "Bundler URL" : "RPC URL"));
}

export function applyEndpointOverrides(
  config: MobileWalletConfiguration,
  overrides: EndpointOverrides
): MobileWalletConfiguration {
  if (!overrides.bundlerUrl && !overrides.rpcUrl) {
    return config;
  }
  return {
    ...config,
    network: {
      ...config.network,
      bundlerUrl: overrides.bundlerUrl ?? config.network.bundlerUrl,
      rpcUrl: overrides.rpcUrl ?? config.network.rpcUrl
    }
  };
}

// Bundler profiles (G-003 UI).
//
// A single bundler is a liveness and observability chokepoint: it sees every
// UserOperation (sender, calldata, gas, IP, timing). Saving more than one
// qualified bundler and letting the user switch is a mitigation, not a fix —
// only one bundler is ever active at a time here; there is no automatic
// failover. Live qualification evidence across independent bundlers is
// tracked separately in GAPS.md (G-003) and is not something this UI can
// provide by itself.
//
// The active profile's URL is mirrored into loom.endpoints.bundler (the
// existing single-URL override key) rather than kept as a second source of
// truth, so every transport builder that already reads that key picks up a
// profile switch with no other wiring change.

export interface BundlerProfile {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

const MAX_BUNDLER_PROFILES = 8;

function parseBundlerProfiles(raw: string | null): BundlerProfile[] {
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (value): value is BundlerProfile =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as BundlerProfile).id === "string" &&
      typeof (value as BundlerProfile).label === "string" &&
      typeof (value as BundlerProfile).url === "string"
  );
}

async function persistBundlerProfiles(store: SecureLocalStore, profiles: readonly BundlerProfile[]): Promise<void> {
  if (profiles.length === 0) {
    await store.delete("loom.endpoints.bundlerProfiles");
    return;
  }
  await store.set("loom.endpoints.bundlerProfiles", JSON.stringify(profiles));
}

export async function loadBundlerProfiles(store: SecureLocalStore): Promise<readonly BundlerProfile[]> {
  return parseBundlerProfiles(await store.get("loom.endpoints.bundlerProfiles"));
}

export async function addBundlerProfile(
  store: SecureLocalStore,
  label: string,
  url: string
): Promise<readonly BundlerProfile[]> {
  const trimmedLabel = label.trim();
  if (trimmedLabel.length === 0) {
    throw new MobileWalletConfigurationError("Bundler profile label must not be empty.");
  }
  const validatedUrl = assertEndpointUrl(url, "Bundler URL");
  const existing = await loadBundlerProfiles(store);
  if (existing.length >= MAX_BUNDLER_PROFILES) {
    throw new MobileWalletConfigurationError("Too many saved bundler profiles.", { limit: MAX_BUNDLER_PROFILES });
  }
  if (existing.some(profile => profile.label === trimmedLabel)) {
    throw new MobileWalletConfigurationError("A bundler profile with this label already exists.", {
      label: trimmedLabel
    });
  }
  const profile: BundlerProfile = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: trimmedLabel,
    url: validatedUrl
  };
  const next = [...existing, profile];
  await persistBundlerProfiles(store, next);
  return next;
}

export async function removeBundlerProfile(store: SecureLocalStore, id: string): Promise<readonly BundlerProfile[]> {
  const existing = await loadBundlerProfiles(store);
  const next = existing.filter(profile => profile.id !== id);
  await persistBundlerProfiles(store, next);
  return next;
}

export async function activateBundlerProfile(store: SecureLocalStore, id: string): Promise<BundlerProfile> {
  const existing = await loadBundlerProfiles(store);
  const profile = existing.find(candidate => candidate.id === id);
  if (!profile) {
    throw new MobileWalletConfigurationError("Bundler profile not found.", { id });
  }
  await saveEndpointOverride(store, "bundler", profile.url);
  return profile;
}
