import { createPasskeySigner } from "@loom/sdk";

import type { Hex, PlatformPasskeyAuthenticator } from "../types/wallet";

export function createMobilePasskeySigner(input: {
  credentialIdHash: Hex;
  rpId: string;
  origin: string;
  passkey: PlatformPasskeyAuthenticator;
}) {
  return createPasskeySigner({
    credentialId: input.credentialIdHash,
    rpId: input.rpId,
    origin: input.origin,
    async signChallenge(challenge) {
      const assertion = await input.passkey.signWithPasskey({
        rpId: input.rpId,
        expectedOrigin: input.origin,
        credentialIdHash: input.credentialIdHash,
        challenge: challenge.userOperationHash
      });
      return assertion;
    }
  });
}
