import type { Hex } from "@loom/core";
import type { PasskeyAssertion, PasskeyChallenge } from "@loom/sdk";

// Drive the platform authenticator over a canonical user-operation challenge and
// return the raw WebAuthn assertion the account validator expects. The private
// credential never leaves the authenticator; only the assertion is returned.
export async function signWithBrowserPasskey(challenge: PasskeyChallenge): Promise<PasskeyAssertion> {
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

function bytesFromHex(value: Hex): Uint8Array<ArrayBuffer> {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("Passkey challenge is not valid hex.");
  const pairs = value.slice(2).match(/../g) ?? [];
  const output = new Uint8Array(pairs.length);
  for (let index = 0; index < pairs.length; index += 1) output[index] = Number.parseInt(pairs[index]!, 16);
  return output;
}

function hexFromBytes(value: Uint8Array): Hex {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
