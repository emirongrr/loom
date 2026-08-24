import type { Address, Hex } from "@loom/core";

/**
 * Finding an account from nothing but its passkey.
 *
 * A fresh browser profile -- a private window, a new device, a cleared browser
 * -- has no list of wallets, while the passkey itself is still there in the
 * platform authenticator. The account was not lost; only the note saying it
 * exists was.
 *
 * An assertion does not reveal the public key, and the Loom address is derived
 * from that key, so the passkey alone cannot name its account. But the account
 * published the key when it installed its validator, and the assertion proves
 * which key signed. Intersecting the two identifies the account with no
 * registry, no server, and nothing stored anywhere in advance.
 *
 * Only candidates the chain already published are considered, and each is
 * confirmed by verifying the signature against it. A candidate that does not
 * verify is not a near miss; it is a different account.
 */
export interface KeyCandidate {
  readonly account: Address;
  readonly x: Hex;
  readonly y: Hex;
  readonly rpIdHash: Hex;
  readonly originHash: Hex;
}

export interface PasskeyAssertion {
  readonly credentialId: Hex;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  /** As the authenticator returns it: ASN.1 DER. */
  readonly signature: Uint8Array;
}

/**
 * What WebAuthn actually signs: the authenticator data followed by the SHA-256
 * of the client data. Rebuilt here so the check does not depend on the
 * authenticator agreeing about it afterwards.
 */
export async function webauthnSignedMessage(
  assertion: Pick<PasskeyAssertion, "authenticatorData" | "clientDataJSON">,
  subtle: SubtleCrypto = crypto.subtle
): Promise<Uint8Array> {
  const clientDataHash = new Uint8Array(await subtle.digest("SHA-256", view(assertion.clientDataJSON)));
  const message = new Uint8Array(assertion.authenticatorData.length + clientDataHash.length);
  message.set(assertion.authenticatorData, 0);
  message.set(clientDataHash, assertion.authenticatorData.length);
  return message;
}

/**
 * DER `SEQUENCE { INTEGER r, INTEGER s }` to the fixed 64 bytes WebCrypto wants.
 *
 * DER integers are signed, so a value whose top bit is set carries a leading
 * zero byte that has to come off, and a short value has to be padded back to
 * 32. Getting either wrong produces a signature that fails to verify against
 * the right key, which would read as "this is not your account".
 */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) throw new Error("signature is not DER");
  let offset = 2;
  // A long-form length byte means the body is longer than 127 bytes, which a
  // P-256 signature never is.
  if ((der[1] ?? 0) > 0x80) throw new Error("signature is not a P-256 DER signature");
  const readInteger = (): Uint8Array => {
    if (der[offset] !== 0x02) throw new Error("signature is not DER");
    const length = der[offset + 1] ?? 0;
    const start = offset + 2;
    const value = der.slice(start, start + length);
    offset = start + length;
    return value;
  };
  return Uint8Array.from([...pad32(readInteger()), ...pad32(readInteger())]);
}

function pad32(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.slice(start);
  if (trimmed.length > 32) throw new Error("signature component is out of range");
  const padded = new Uint8Array(32);
  padded.set(trimmed, 32 - trimmed.length);
  return padded;
}

/** True when this candidate's key produced this signature. */
export async function candidateSigned(input: {
  readonly candidate: Pick<KeyCandidate, "x" | "y">;
  readonly message: Uint8Array;
  readonly rawSignature: Uint8Array;
  readonly subtle?: SubtleCrypto;
}): Promise<boolean> {
  const subtle = input.subtle ?? crypto.subtle;
  try {
    const point = new Uint8Array(65);
    point[0] = 0x04;
    point.set(hexBytes(input.candidate.x), 1);
    point.set(hexBytes(input.candidate.y), 33);
    const key = await subtle.importKey("raw", view(point), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, view(input.rawSignature), view(input.message));
  } catch {
    // A malformed candidate is simply not the one. Nothing about a bad point
    // should stop the remaining candidates from being tried.
    return false;
  }
}

/**
 * The account this passkey controls, or null when none of the published keys
 * signed.
 *
 * Narrowed by the relying party and origin the account committed to before any
 * signature is checked, so a key belonging to another site's account is never
 * even a candidate.
 */
export async function findAccountForAssertion(input: {
  readonly candidates: readonly KeyCandidate[];
  readonly assertion: PasskeyAssertion;
  readonly rpIdHash: Hex;
  readonly originHash: Hex;
  readonly subtle?: SubtleCrypto;
}): Promise<KeyCandidate | null> {
  const subtle = input.subtle ?? crypto.subtle;
  const message = await webauthnSignedMessage(input.assertion, subtle);
  const rawSignature = derToRawSignature(input.assertion.signature);
  const scoped = input.candidates.filter(candidate =>
    candidate.rpIdHash.toLowerCase() === input.rpIdHash.toLowerCase()
    && candidate.originHash.toLowerCase() === input.originHash.toLowerCase());
  for (const candidate of scoped) {
    if (await candidateSigned({ candidate, message, rawSignature, subtle })) return candidate;
  }
  return null;
}

const hexBytes = (value: Hex): Uint8Array =>
  Uint8Array.from((value.slice(2).match(/.{2}/gu) ?? []).map(pair => Number.parseInt(pair, 16)));

/** Web Crypto wants an ArrayBuffer-backed view, not a possibly shared one. */
const view = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
