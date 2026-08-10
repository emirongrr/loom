import { createPasskeySigner } from "@loom/sdk";

import { requireAccountDeploymentConfig } from "./client";
import type { Hex, MobileWalletConfiguration, PlatformPasskeyAuthenticator } from "../types/wallet";

// The SDK requires the installed validator and the EntryPoint as
// construction-time commitments: the signer encodes the validator into every
// signature envelope and binds the hash it signs to that EntryPoint. This
// wrapper had never passed either, so it did not type-check against the SDK it
// depends on -- which nothing noticed, because this example's typecheck is not
// run by any gate.
//
// They are taken from the wallet configuration through the same resolver the
// account creation flow uses, rather than as free parameters. A signer built
// with a validator or EntryPoint that disagreed with the configured deployment
// would produce envelopes the account rejects, and the failure would surface as
// an unexplained invalid signature rather than as configuration that was never
// set.
export function createMobilePasskeySigner(input: {
  config: MobileWalletConfiguration;
  credentialIdHash: Hex;
  passkey: PlatformPasskeyAuthenticator;
}) {
  const deployment = requireAccountDeploymentConfig(input.config);
  const { rpId, origin } = input.config;

  return createPasskeySigner({
    credentialId: input.credentialIdHash,
    rpId,
    origin,
    validator: deployment.passkeyValidator,
    entryPoint: deployment.entryPoint,
    async signChallenge(challenge) {
      return input.passkey.signWithPasskey({
        rpId,
        expectedOrigin: origin,
        credentialIdHash: input.credentialIdHash,
        challenge: challenge.userOperationHash
      });
    }
  });
}
