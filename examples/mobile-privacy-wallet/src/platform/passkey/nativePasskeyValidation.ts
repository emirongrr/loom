import { MobileWalletConfigurationError } from "../errors";
import type { Hex, PlatformPasskeyAssertion, PlatformPasskeyRegistration } from "../../types/wallet";

// Width is part of the contract for values crossing the native boundary. The
// native implementations enforce these shapes too, but keeping this validation
// independent makes the JS boundary fail closed for future platform adapters.
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

export function validateNativePasskeyRegistration(
  output: PlatformPasskeyRegistration
): PlatformPasskeyRegistration {
  // P-256 coordinates and a SHA-256 credential id hash are each exactly 32 bytes.
  assertHex(output.publicKeyX, "publicKeyX", 32);
  assertHex(output.publicKeyY, "publicKeyY", 32);
  assertHex(output.credentialIdHash, "credentialIdHash", 32);
  if (!output.rpId || !output.origin) {
    throw new MobileWalletConfigurationError("Native passkey registration omitted RP binding.");
  }
  return output;
}

export function validateNativePasskeyAssertion(output: PlatformPasskeyAssertion): PlatformPasskeyAssertion {
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
