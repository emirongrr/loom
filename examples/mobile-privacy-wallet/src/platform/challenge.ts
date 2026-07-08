import { MobileWalletConfigurationError } from "./errors";
import type { Hex } from "../types/wallet";

// Passkey registration challenges.
//
// The native modules already reject challenges that are not exactly 32 bytes
// or are all zeroes; this is the app-runtime side of the same contract. A
// challenge must come from a real entropy source at the moment of use — never
// a constant, never reused.

export const CHALLENGE_BYTE_LENGTH = 32;

export type RandomBytesFn = (byteCount: number) => Promise<Uint8Array>;

export function challengeFromBytes(bytes: Uint8Array): Hex {
  if (bytes.length !== CHALLENGE_BYTE_LENGTH) {
    throw new MobileWalletConfigurationError("Passkey challenge must be exactly 32 bytes.", {
      received: bytes.length
    });
  }
  if (bytes.every(value => value === 0)) {
    throw new MobileWalletConfigurationError("Passkey challenge must not be all zeroes.");
  }
  let hex = "0x";
  for (const value of bytes) {
    hex += value.toString(16).padStart(2, "0");
  }
  return hex as Hex;
}

export interface ChallengeSource {
  freshChallenge(): Promise<Hex>;
}

export function createChallengeSource(getRandomBytes: RandomBytesFn): ChallengeSource {
  return {
    async freshChallenge() {
      return challengeFromBytes(await getRandomBytes(CHALLENGE_BYTE_LENGTH));
    }
  };
}
