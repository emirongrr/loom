// @loom/passkey — the platform-neutral passkey surface for Loom accounts.
//
// A browser or mobile wallet needs to turn a WebAuthn assertion into the exact
// signature a Loom account validates, and to know the shape of the passkey
// provider it must implement — WITHOUT pulling in the wallet engine (bundler
// transport, state transport, privacy runtime). This package is that surface:
// the canonical WebAuthn/P-256 encoding, the provider contract, and a minimal
// signer that operates on a user-operation hash the caller computes with
// @loom/core. It depends only on @loom/core.

import {
  base64UrlEncode,
  encodeValidatorSignature,
  encodeWebAuthnSignature,
  parseP256Signature
} from "@loom/core";

export {
  // The canonical WebAuthn/P-256 encoding, re-exported so a passkey consumer
  // imports it from one place without depending on the wallet engine.
  base64UrlEncode,
  encodeValidatorSignature,
  encodeWebAuthnSignature,
  parseP256Signature
} from "@loom/core";
export type { Address, Hex, WebAuthnSignatureFields } from "@loom/core";

type Hex = `0x${string}`;

// --- provider contract ----------------------------------------------------

/** A raw WebAuthn assertion as a platform authenticator returns it. */
export interface PasskeyAssertion {
  authenticatorData: Hex;
  clientDataJSON: Hex;
  /** The authenticator's P-256 signature: 64-byte raw `r || s` or ASN.1 DER. */
  signature: Hex;
  userHandle?: Hex;
}

/** What a passkey provider is asked to sign. */
export interface PasskeyChallenge {
  /** base64url of the canonical user-operation hash — the WebAuthn challenge. */
  challenge: string;
  userOperationHash: Hex;
  origin: string;
  rpId?: string;
  credentialId?: string;
}

/** The platform passkey module a wallet supplies. */
export type PasskeyProvider = (challenge: PasskeyChallenge) => Promise<PasskeyAssertion> | PasskeyAssertion;

// --- encoding helpers -----------------------------------------------------

/**
 * Encode a raw WebAuthn assertion into the account-level signature envelope
 * `(validator, WebAuthnSignature)` that a Loom account validates. Parses the
 * P-256 signature (raw64 or DER, normalized to low-s) and packs the struct.
 * Platform-neutral: no chain, no wallet engine.
 */
export function encodeWebAuthnValidatorSignature(input: {
  validator: string;
  origin: string;
  assertion: PasskeyAssertion;
}): Hex {
  const { r, s } = parseP256Signature(input.assertion.signature);
  return encodeValidatorSignature(
    input.validator as `0x${string}`,
    encodeWebAuthnSignature({
      authenticatorData: input.assertion.authenticatorData,
      clientDataJSON: input.assertion.clientDataJSON,
      origin: input.origin,
      r,
      s
    })
  );
}

/** The base64url WebAuthn challenge for a canonical user-operation hash. */
export function passkeyChallenge(userOperationHash: Hex): string {
  return base64UrlEncode(userOperationHash);
}

// A representative, signature-shaped dummy for gas estimation: the same
// validator, WebAuthn field sizes, and low-s r/s bounds a real assertion has.
function dummyValidatorSignature(validator: string, origin: string): Hex {
  return encodeValidatorSignature(
    validator as `0x${string}`,
    encodeWebAuthnSignature({
      authenticatorData: `0x${"00".repeat(37)}`,
      clientDataJSON: `0x${"00".repeat(134)}`,
      origin,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`
    })
  );
}

// --- signer ---------------------------------------------------------------

export interface WebAuthnSigner {
  readonly validator: Hex;
  readonly origin: string;
  readonly rpId?: string;
  /** A signature-shaped dummy for gas estimation before a real assertion. */
  readonly dummySignature: Hex;
  /** Verification gas the dummy cannot exercise (hash-bound P-256 tail). */
  readonly verificationGasBuffer: bigint;
  /** Drive the provider over a user-operation hash and return the envelope. */
  sign(userOperationHash: Hex): Promise<Hex>;
}

/**
 * A minimal, engine-free passkey signer. The caller computes the canonical
 * user-operation hash (e.g. with `getUserOpHash` from @loom/core) and passes it
 * to `sign`, which drives the platform provider and returns the account-ready
 * `(validator, WebAuthnSignature)` envelope. No bundler, no transport, no
 * privacy runtime — everything a browser or mobile wallet needs to sign.
 */
export function createWebAuthnSigner(options: {
  validator: string;
  origin: string;
  rpId?: string;
  credentialId?: string;
  signChallenge: PasskeyProvider;
}): WebAuthnSigner {
  if (!options || typeof options.signChallenge !== "function") {
    throw new Error("createWebAuthnSigner requires a signChallenge provider");
  }
  if (typeof options.origin !== "string" || options.origin.length === 0) {
    throw new Error("createWebAuthnSigner requires an origin");
  }
  const validator = options.validator as Hex;
  const { origin, rpId, credentialId } = options;

  return Object.freeze({
    validator,
    origin,
    ...(rpId === undefined ? {} : { rpId }),
    dummySignature: dummyValidatorSignature(validator, origin),
    // The account's WebAuthn validator checks rpId, flags, origin, and the
    // hash-bound challenge before the P-256 verification, so a dummy exits
    // before the curve check; this margin covers the unseen tail and stays
    // inside the documented 1.5M validation ceiling.
    verificationGasBuffer: 400_000n,
    async sign(userOperationHash: Hex): Promise<Hex> {
      const challenge: PasskeyChallenge = {
        challenge: passkeyChallenge(userOperationHash),
        userOperationHash,
        origin,
        ...(rpId === undefined ? {} : { rpId }),
        ...(credentialId === undefined ? {} : { credentialId })
      };
      const assertion = await options.signChallenge(challenge);
      return encodeWebAuthnValidatorSignature({ validator, origin, assertion });
    }
  });
}
