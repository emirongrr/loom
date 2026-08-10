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

// Width is the point of these fields, and the old check ignored it: the pattern
// ended in `*`, so `0x` satisfied it, and an odd number of digits did too. A
// public key coordinate that is empty or truncated derives a different account
// address -- one nobody holds a credential for -- and the wallet would have
// carried it as far as the derivation before anything noticed.
//
// Both native modules already enforce 32-byte coordinates (iOS `x.count == 32`,
// Android `require(x?.size == 32 ...)`), so this is the second line rather than
// the first. It is also the line that stays true if a third platform is added.
function assertHex(value: string, field: string, byteLength?: number): asserts value is Hex {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new MobileWalletConfigurationError(`Native passkey module returned invalid ${field}.`, {
      field
    });
  }
  if (byteLength !== undefined && value.length !== 2 + byteLength * 2) {
    throw new MobileWalletConfigurationError(`Native passkey module returned ${field} of the wrong length.`, {
      field,
      expectedBytes: byteLength,
      receivedBytes: (value.length - 2) / 2
    });
  }
}

function assertMinimumHex(value: string, field: string, minimumBytes: number): asserts value is Hex {
  assertHex(value, field);
  if ((value.length - 2) / 2 < minimumBytes) {
    throw new MobileWalletConfigurationError(`Native passkey module returned ${field} that is too short.`, {
      field,
      minimumBytes
    });
  }
}

function validateRegistration(output: PlatformPasskeyRegistration): PlatformPasskeyRegistration {
  // P-256 coordinates and a SHA-256 credential id hash are each exactly 32 bytes.
  assertHex(output.publicKeyX, "publicKeyX", 32);
  assertHex(output.publicKeyY, "publicKeyY", 32);
  assertHex(output.credentialIdHash, "credentialIdHash", 32);
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
  // 37 bytes is the WebAuthn minimum: 32-byte RP ID hash, flags, counter. Both
  // native modules normalise the signature to raw r||s, so it is exactly 64.
  assertMinimumHex(output.authenticatorData, "authenticatorData", 37);
  assertMinimumHex(output.clientDataJSON, "clientDataJSON", 1);
  assertHex(output.signature, "signature", 64);
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
