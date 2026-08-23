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

/**
 * A stable secret the account's own passkey derives, when it can.
 *
 * WebAuthn's PRF extension asks the authenticator for a value derived from the
 * credential and a salt we choose. It never leaves the authenticator's control
 * and is not stored anywhere: unlocking the passkey reproduces it, and nothing
 * else does. Where the passkey itself syncs between a person's devices, so does
 * this, which is what lets a file encrypted on one of them open on another
 * without a second secret to remember and lose.
 *
 * Returns null when the authenticator declines. Plenty do, and the caller must
 * have somewhere else to go rather than treating this as a guarantee.
 */
export async function passkeyDerivedSecret(input: {
  readonly credentialId: Hex;
  readonly rpId?: string;
  readonly salt: Uint8Array;
}): Promise<Uint8Array | null> {
  if (!window.PublicKeyCredential || !navigator.credentials) return null;
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        ...(input.rpId ? { rpId: input.rpId } : {}),
        allowCredentials: [{ type: "public-key", id: bytesFromHex(input.credentialId) }],
        userVerification: "required",
        timeout: 60_000,
        extensions: { prf: { eval: { first: input.salt } } }
      } as PublicKeyCredentialRequestOptions
    });
    if (!(credential instanceof PublicKeyCredential)) return null;
    const results = (credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf;
    const first = results?.results?.first;
    return first ? new Uint8Array(first) : null;
  } catch {
    // An authenticator that refuses the extension, or a person who cancels.
    // Neither is an error here; both mean "use the other route".
    return null;
  }
}
