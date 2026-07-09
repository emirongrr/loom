import { MobileWalletConfigurationError } from "./errors";

// Local persistence policy.
//
// The security model (README) forbids persisting raw credential identifiers,
// attestation objects, viewing keys, account-graph data, and private
// transaction metadata. This wrapper turns that documentation into code: only
// allowlisted keys can be written, and the allowlist is the single place a
// fork must edit — consciously — to persist anything new. The backend must be
// the platform-encrypted store (expo-secure-store: Keychain on iOS,
// EncryptedSharedPreferences-backed storage on Android), never AsyncStorage
// or a plain file.

export const SECURE_STORE_ALLOWED_KEYS = Object.freeze([
  // sha-256 of the credential id, required to request an assertion later.
  // Raw credential ids must never be stored.
  "loom.credentialIdHash",
  // Encrypted guardian ceremony backup blob produced by @loom/guardian.
  "loom.guardianBackup.encrypted",
  // User-supplied infrastructure endpoints entered from the settings screen.
  // Endpoints are replaceable transports, not secrets, but they still live in
  // the encrypted store so nothing in this app uses plaintext persistence.
  "loom.endpoints.bundler",
  "loom.endpoints.rpc"
] as const);

export type SecureStoreKey = (typeof SECURE_STORE_ALLOWED_KEYS)[number];

// Belt-and-braces guard for future allowlist edits: even an allowlisted key
// must not look like it stores forbidden material.
const FORBIDDEN_KEY_PATTERN =
  /credentialId(?!Hash)|attestation|viewingKey|accountGraph|userAgent|privateKey|mnemonic|seed/i;

const MAX_VALUE_BYTES = 16 * 1024;

export interface SecureStoreBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface SecureLocalStore {
  get(key: SecureStoreKey): Promise<string | null>;
  set(key: SecureStoreKey, value: string): Promise<void>;
  delete(key: SecureStoreKey): Promise<void>;
}

function assertAllowedKey(key: string): void {
  if (!(SECURE_STORE_ALLOWED_KEYS as readonly string[]).includes(key)) {
    throw new MobileWalletConfigurationError("Secure store key is not allowlisted.", { key });
  }
  if (FORBIDDEN_KEY_PATTERN.test(key)) {
    throw new MobileWalletConfigurationError("Secure store key names forbidden material.", { key });
  }
}

export function createSecureLocalStore(input: { backend: SecureStoreBackend }): SecureLocalStore {
  if (!input.backend) {
    throw new MobileWalletConfigurationError(
      "Secure local storage requires a platform-encrypted backend; nothing is persisted without one."
    );
  }
  const backend = input.backend;

  return {
    async get(key) {
      assertAllowedKey(key);
      return backend.getItem(key);
    },
    async set(key, value) {
      assertAllowedKey(key);
      if (value.length === 0) {
        throw new MobileWalletConfigurationError("Refusing to persist an empty value.", { key });
      }
      if (value.length > MAX_VALUE_BYTES) {
        throw new MobileWalletConfigurationError("Value exceeds the secure store size limit.", {
          key,
          limit: MAX_VALUE_BYTES
        });
      }
      await backend.setItem(key, value);
    },
    async delete(key) {
      assertAllowedKey(key);
      await backend.deleteItem(key);
    }
  };
}
