import { requireNativeModule } from "expo-modules-core";

import { MobileWalletConfigurationError } from "../errors";
import type {
  Hex,
  PlatformPasskeyAssertion,
  PlatformPasskeyAuthenticator,
  PlatformPasskeyRegistration
} from "../../types/wallet";

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

function assertHex(value: string, field: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new MobileWalletConfigurationError(`Native passkey module returned invalid ${field}.`, {
      field
    });
  }
}

function validateRegistration(output: PlatformPasskeyRegistration): PlatformPasskeyRegistration {
  assertHex(output.publicKeyX, "publicKeyX");
  assertHex(output.publicKeyY, "publicKeyY");
  assertHex(output.credentialIdHash, "credentialIdHash");
  if (!output.rpId || !output.origin) {
    throw new MobileWalletConfigurationError("Native passkey registration omitted RP binding.");
  }
  return output;
}

function assertRegistrationBinding(
  input: { rpId: string; expectedOrigin: string },
  output: PlatformPasskeyRegistration
): PlatformPasskeyRegistration {
  const registration = validateRegistration(output);
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

function validateAssertion(output: PlatformPasskeyAssertion): PlatformPasskeyAssertion {
  assertHex(output.authenticatorData, "authenticatorData");
  assertHex(output.clientDataJSON, "clientDataJSON");
  assertHex(output.signature, "signature");
  if (output.userHandle !== undefined) {
    assertHex(output.userHandle, "userHandle");
  }
  return output;
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
      return validateAssertion(await nativeModule.signWithPasskey(input));
    }
  };
}
