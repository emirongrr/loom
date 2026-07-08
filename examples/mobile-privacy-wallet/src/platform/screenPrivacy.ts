import { requireNativeModule } from "expo-modules-core";

import { MobileWalletConfigurationError } from "./errors";

interface LoomScreenPrivacyNativeModule {
  isScreenPrivacyAvailable(): Promise<boolean>;
  setSecureScreen(enabled: boolean): Promise<boolean>;
}

export interface ScreenPrivacyShield {
  isAvailable(): Promise<boolean>;
  /**
   * Android: applies FLAG_SECURE (blocks screenshots, recording, and the
   * recent-apps thumbnail). iOS: covers the window with a blur overlay before
   * the app-switcher snapshot is taken; screenshots cannot be blocked on iOS
   * and must not be claimed. Fails closed when the native module is missing.
   */
  enable(): Promise<void>;
  disable(): Promise<void>;
}

function loadNativeModule(): LoomScreenPrivacyNativeModule {
  try {
    return requireNativeModule<LoomScreenPrivacyNativeModule>("LoomScreenPrivacy");
  } catch (error) {
    throw new MobileWalletConfigurationError("Native screen privacy module is not available.", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function createScreenPrivacyShield(): ScreenPrivacyShield {
  const nativeModule = loadNativeModule();

  return {
    isAvailable() {
      return nativeModule.isScreenPrivacyAvailable();
    },
    async enable() {
      const applied = await nativeModule.setSecureScreen(true);
      if (!applied) {
        throw new MobileWalletConfigurationError("Secure screen flag was not applied.");
      }
    },
    async disable() {
      await nativeModule.setSecureScreen(false);
    }
  };
}
