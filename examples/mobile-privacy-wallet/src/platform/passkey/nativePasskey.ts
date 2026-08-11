import { requireNativeModule } from "expo-modules-core";

import { MobileWalletConfigurationError } from "../errors";
import type {
  Hex,
  PlatformPasskeyAssertion,
  PlatformPasskeyAuthenticator,
  PlatformPasskeyRegistration
} from "../../types/wallet";
import {
  validateNativePasskeyAssertion,
  validateNativePasskeyRegistration
} from "./nativePasskeyValidation";

interface LoomPasskeyNativeModule {
  isPlatformPasskeyAvailable(): Promise<boolean>;
  createPasskey(input: {
    rpId: string;
    expectedOrigin: string;
    challenge: Hex;
    userName: string;
    displayName: string;
  }): Promise<PlatformPasskeyRegistration>;
  signWithPasskey(input: {
    rpId: string;
    expectedOrigin: string;
    challenge: Hex;
    credentialIdHash: Hex;
  }): Promise<PlatformPasskeyAssertion>;
}

function loadNativeModule(): LoomPasskeyNativeModule {
  try {
    return requireNativeModule<LoomPasskeyNativeModule>("LoomPasskey");
  } catch (error) {
    throw new MobileWalletConfigurationError("Native passkey module is not available.", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function assertRegistrationBinding(
  input: { rpId: string; expectedOrigin: string },
  output: PlatformPasskeyRegistration
): PlatformPasskeyRegistration {
  const registration = validateNativePasskeyRegistration(output);
  if (registration.rpId !== input.rpId || registration.origin !== input.expectedOrigin) {
    throw new MobileWalletConfigurationError("Native passkey registration returned an unexpected WebAuthn binding.", {
      expectedRpId: input.rpId,
      returnedRpId: registration.rpId,
      expectedOrigin: input.expectedOrigin,
      returnedOrigin: registration.origin
    });
  }
  return registration;
}

export function createNativePasskeyAuthenticator(): PlatformPasskeyAuthenticator {
  const nativeModule = loadNativeModule();

  return {
    isPlatformPasskeyAvailable() {
      return nativeModule.isPlatformPasskeyAvailable();
    },
    async createPasskey(input) {
      const available = await nativeModule.isPlatformPasskeyAvailable();
      if (!available) {
        throw new MobileWalletConfigurationError("Platform passkeys are not available on this device.");
      }
      return assertRegistrationBinding(input, await nativeModule.createPasskey(input));
    },
    async signWithPasskey(input) {
      const available = await nativeModule.isPlatformPasskeyAvailable();
      if (!available) {
        throw new MobileWalletConfigurationError("Platform passkeys are not available on this device.");
      }
      return validateNativePasskeyAssertion(await nativeModule.signWithPasskey(input));
    }
  };
}
