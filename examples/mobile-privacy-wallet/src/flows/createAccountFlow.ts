import { blockedGate } from "../platform/errors";
import type {
  AccountCreationReadiness,
  FlowResult,
  Hex,
  MobileWalletConfiguration,
  PlatformPasskeyAuthenticator
} from "../types/wallet";
import { requireAccountDeploymentConfig } from "../loom/client";
import { configurationReadiness } from "../config/environment";

export async function preparePasskeyAccountCreation(input: {
  config: MobileWalletConfiguration;
  passkey: PlatformPasskeyAuthenticator;
  userName: string;
  displayName: string;
  registrationChallenge?: Hex;
}): Promise<FlowResult<AccountCreationReadiness>> {
  // Refuse to touch the passkey authenticator until the critical configuration
  // (chain, relying-party id, origin, deployment addresses) is explicitly set.
  // This prevents creating a credential bound to an empty or assumed origin.
  const configGates = configurationReadiness(input.config);
  if (configGates.length > 0) {
    return { status: "blocked", gates: configGates };
  }

  const available = await input.passkey.isPlatformPasskeyAvailable();
  if (!available) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "passkey.platform.unavailable",
          title: "Platform passkey unavailable",
          summary: "This device cannot create a platform passkey for the wallet."
        })
      ]
    };
  }

  if (!input.registrationChallenge) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "passkey.registration.challenge.missing",
          title: "Registration challenge required",
          summary:
            "Passkey registration requires a fresh 32-byte challenge from the app runtime before creating an account."
        })
      ]
    };
  }

  const registration = await input.passkey.createPasskey({
    rpId: input.config.rpId,
    expectedOrigin: input.config.origin,
    challenge: input.registrationChallenge,
    userName: input.userName,
    displayName: input.displayName
  });

  try {
    requireAccountDeploymentConfig(input.config);
  } catch (error) {
    return {
      status: "blocked",
      gates: [
        blockedGate({
          id: "deployment.config.missing",
          title: "Deployment configuration missing",
          summary:
            error instanceof Error
              ? error.message
              : "Factory, EntryPoint, and passkey validator configuration is required."
        })
      ]
    };
  }

  return {
    status: "ready",
    value: {
      registration,
      recoveryStatus: "unprotected-recovery"
    },
    gates: [
      blockedGate({
        id: "recovery.guardians.not-configured",
        title: "Recovery is not protected yet",
        summary:
          "The account can be created with a passkey, but guardian recovery must be configured later."
      })
    ]
  };
}
