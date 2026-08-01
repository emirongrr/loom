import type { Hex } from "@loom/core";
import { bytesFromHex, hexFromBytes } from "../../services/webauthn/encoding.ts";

// Typed structurally rather than against one package's challenge type: the SDK's
// account client and @loom/passkey's raw-hash signer describe the same ceremony
// with different surrounding fields, and this only ever needs the hash to sign
// and the credential to sign it with.

export interface PasskeySignRequest {
  /** The canonical operation hash the authenticator signs over. */
  readonly userOperationHash: Hex;
  readonly rpId?: string;
  readonly credentialId?: string;
}

export interface BrowserPasskeyAssertion {
  readonly authenticatorData: Hex;
  readonly clientDataJSON: Hex;
  readonly signature: Hex;
}

/**
 * Drive the platform authenticator over a canonical operation hash and return
 * the raw WebAuthn assertion the account's validator expects. The private
 * credential never leaves the authenticator; only the assertion is returned.
 */
export async function signWithBrowserPasskey(challenge: PasskeySignRequest): Promise<BrowserPasskeyAssertion> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser does not support passkeys.");
  if (!challenge.credentialId) throw new Error("A credential id is required to sign.");
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: bytesFromHex(challenge.userOperationHash),
      ...(challenge.rpId ? { rpId: challenge.rpId } : {}),
      allowCredentials: [{ type: "public-key", id: bytesFromHex(challenge.credentialId as Hex) }],
      userVerification: "required",
      timeout: 60_000
    }
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("Passkey authentication returned an unsupported credential.");
  }
  return Object.freeze({
    authenticatorData: hexFromBytes(new Uint8Array(credential.response.authenticatorData)),
    clientDataJSON: hexFromBytes(new Uint8Array(credential.response.clientDataJSON)),
    signature: hexFromBytes(new Uint8Array(credential.response.signature))
  });
}
