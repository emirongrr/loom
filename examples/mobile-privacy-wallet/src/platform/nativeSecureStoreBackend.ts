import * as SecureStore from "expo-secure-store";

import type { SecureStoreBackend } from "./secureStore";

// expo-secure-store backend: Keychain on iOS, encrypted SharedPreferences on
// Android. Values are bound to this device and never migrate through cloud
// backups (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), so a restored device must
// re-register its passkey instead of inheriting stale credential state.
export function createNativeSecureStoreBackend(): SecureStoreBackend {
  const options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  };

  return {
    getItem(key) {
      return SecureStore.getItemAsync(key, options);
    },
    async setItem(key, value) {
      await SecureStore.setItemAsync(key, value, options);
    },
    async deleteItem(key) {
      await SecureStore.deleteItemAsync(key, options);
    }
  };
}
