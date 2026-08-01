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
export const DEFAULT_NETWORK: NetworkConfig = Object.freeze({
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
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

export function saveNetworkConfig(config: NetworkConfig, storage: Storage = window.localStorage): NetworkConfig {
  const normalized = normalizeNetworkConfig(config);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function transactionUrl(config: NetworkConfig, hash: string): string {
  return `${config.explorerUrl.replace(/\/$/, "")}/tx/${hash}`;
}
