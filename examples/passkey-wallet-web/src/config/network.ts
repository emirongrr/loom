import { AppError } from "../domain/errors/appError.ts";

// Network endpoints the wallet talks to. Infrastructure is replaceable: the
// account's authority never depends on which RPC or bundler is chosen, so these
// are ordinary defaults a user can override in Developer settings, not trusted
// components. The defaults are public, keyless endpoints so a fresh install can
// read balances and submit transactions without the user provisioning anything.

const CHAIN_ID = 11155111;

export interface NetworkConfig {
  /** JSON-RPC endpoint used for reads (balance, code) and simulation. */
  readonly rpcUrl: string;
  /** Independent JSON-RPC endpoint used to corroborate security-critical chain evidence. */
  readonly verificationRpcUrl: string;
  /** ERC-4337 bundler endpoint used to submit account operations. */
  readonly bundlerUrl: string;
  /** Block explorer used for transaction links. */
  readonly explorerUrl: string;
  /** Optional sponsor relay for creating/funding accounts (development only). */
  readonly relayUrl: string;
}

// Public Sepolia RPC and Pimlico's keyless public bundler. Neither can alter a
// passkey-signed operation, and the account stays usable through any other
// endpoint the user points at instead.
//
// The read endpoint has to serve historical logs, not just recent ones. Several
// public providers keep only a rolling window -- roughly a day -- and answer a
// query past it with an empty list rather than an error, which reads as "this
// never happened" instead of "I cannot see that far". Account history, and
// finding a wallet from its passkey, are both read from logs, so an endpoint
// that quietly forgets makes the wallet quietly wrong.
export const DEFAULT_NETWORK: NetworkConfig = Object.freeze({
  rpcUrl: "https://sepolia.gateway.tenderly.co",
  verificationRpcUrl: "https://1rpc.io/sepolia",
  bundlerUrl: `https://public.pimlico.io/v2/${CHAIN_ID}/rpc`,
  explorerUrl: "https://eth-sepolia.blockscout.com",
  relayUrl: ""
});

const STORAGE_KEY = "loom.wallet.network.v1";

function isEndpoint(value: unknown, { allowEmpty = false } = {}): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0) return allowEmpty;
  if (value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
}

const ENDPOINT_KEYS = ["rpcUrl", "verificationRpcUrl", "bundlerUrl", "explorerUrl", "relayUrl"] as const;

/**
 * Endpoint fields present in `value` that are not usable, in display order.
 *
 * Separated from `normalizeNetworkConfig` because the two callers want opposite
 * things from a bad value. Reading storage should recover: a damaged record
 * should not leave the wallet unable to reach a chain. Accepting what someone
 * typed should not recover, it should refuse — silently substituting the public
 * default puts the user back on the provider they were trying to leave, and says
 * nothing about it. Infrastructure being replaceable is the point; replacing the
 * user's replacement without telling them is not.
 */
export function invalidNetworkEndpoints(value: unknown): readonly (keyof NetworkConfig)[] {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return Object.freeze(
    ENDPOINT_KEYS.filter(key => record[key] !== undefined && !isEndpoint(record[key], { allowEmpty: key === "relayUrl" }))
  );
}

export function normalizeNetworkConfig(value: unknown): NetworkConfig {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const pick = (key: keyof NetworkConfig, allowEmpty = false): string => {
    const candidate = record[key];
    return isEndpoint(candidate, { allowEmpty }) ? String(candidate) : DEFAULT_NETWORK[key];
  };
  return Object.freeze({
    rpcUrl: pick("rpcUrl"),
    verificationRpcUrl: pick("verificationRpcUrl"),
    bundlerUrl: pick("bundlerUrl"),
    explorerUrl: pick("explorerUrl"),
    relayUrl: pick("relayUrl", true)
  });
}

export function loadNetworkConfig(storage: Storage = window.localStorage): NetworkConfig {
  const text = storage.getItem(STORAGE_KEY);
  if (!text) return DEFAULT_NETWORK;
  try { return normalizeNetworkConfig(JSON.parse(text)); }
  catch { return DEFAULT_NETWORK; }
}

const ENDPOINT_LABELS: Readonly<Record<keyof NetworkConfig, string>> = Object.freeze({
  rpcUrl: "RPC endpoint",
  verificationRpcUrl: "Independent verification RPC",
  bundlerUrl: "Bundler endpoint",
  explorerUrl: "Block explorer",
  relayUrl: "Optional sponsor relay"
});

/** Rejects an unusable endpoint rather than replacing it with a default. */
export function saveNetworkConfig(config: NetworkConfig, storage: Storage = window.localStorage): NetworkConfig {
  const invalid = invalidNetworkEndpoints(config);
  if (invalid.length > 0) {
    const named = invalid.map(key => ENDPOINT_LABELS[key]).join(", ");
    throw new AppError({
      code: "CONFIGURATION_ERROR",
      userMessage: `${named} must be an https:// URL (http:// is allowed for localhost). Nothing was saved.`,
      diagnostic: `rejected endpoint fields: ${invalid.join(", ")}`,
      retryable: true,
      stage: "configuration",
      metadata: { fields: invalid.join(",") }
    });
  }
  const normalized = normalizeNetworkConfig(config);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function transactionUrl(config: NetworkConfig, hash: string): string {
  return `${config.explorerUrl.replace(/\/$/, "")}/tx/${hash}`;
}
