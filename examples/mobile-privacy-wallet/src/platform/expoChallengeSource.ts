import * as Crypto from "expo-crypto";

import { createChallengeSource, type ChallengeSource } from "./challenge";

// expo-crypto backs getRandomBytesAsync with the platform CSPRNG
// (SecRandomCopyBytes on iOS, SecureRandom on Android).
export function createExpoChallengeSource(): ChallengeSource {
  return createChallengeSource(async byteCount => Crypto.getRandomBytesAsync(byteCount));
}
