import type { Hex } from "@loom/core";
import { keccak256, encodeAbiParameters, parseAbiParameters, stringToHex } from "viem";
import { guardianAuthority, type RosterEntry } from "./guardianPlan.ts";
import type { GuardianDescriptor } from "@loom/sdk/recovery";

// Legacy compatibility only. Guardian leaves commit to a per-guardian salt. A random salt keeps guardian
// identities private — without it anyone could test "is this address a guardian
// of that account?" against the published root, and the space of plausible
// guardians is small enough to enumerate.
//
// Random salts cost recoverability: they exist only on the device that generated
// them, so a lost roster cannot be rebuilt even by someone who knows exactly who
// the guardians are.
//
// Deriving the salt from the account's own passkey gives both. The WebAuthn PRF
// extension returns a deterministic value that only the authenticator can
// produce, so the same salts can be recomputed on any device holding the passkey,
// while remaining uniformly unpredictable to everyone else — brute force gains
// nothing, because the attacker cannot evaluate the PRF at all.
//
// The trade this makes: whoever controls the passkey can also confirm guardian
// identities by testing candidates against the root. That is a real narrowing of
// guardian privacy, but it is bounded by an event — passkey compromise — that
// already means loss of the account itself.

const PRF_INFO = "loom.guardian-roster.v1";

/** One PRF evaluation yields a master secret; per-guardian salts are derived
 * from it locally, so adding a guardian needs no new authenticator prompt. */
export type GuardianSaltMaster = Hex;

export interface PasskeyBinding {
  readonly credentialId: Hex;
  readonly rpId: string;
}

/**
 * Ask the authenticator for this account's guardian-salt master secret.
 * Returns null when the authenticator does not support the PRF extension, in
 * which case the caller must fall back to random salts plus an exported backup.
 */
/** @deprecated Existing PRF-derived roots remain verifiable, but new guardian
 * epochs must use independent random salts through withFreshSalts. */
export async function deriveGuardianSaltMaster(
  binding: PasskeyBinding,
  account: string
): Promise<GuardianSaltMaster | null> {
  if (!window.PublicKeyCredential || !navigator.credentials) return null;
  const info = new TextEncoder().encode(`${PRF_INFO}:${account.toLowerCase()}`);
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: binding.rpId,
        allowCredentials: [{ type: "public-key", id: bytesFromHex(binding.credentialId) }],
        userVerification: "required",
        timeout: 60_000,
        extensions: { prf: { eval: { first: info } } } as AuthenticationExtensionsClientInputs
      }
    });
  } catch {
    return null;
  }
  if (!(credential instanceof PublicKeyCredential)) return null;
  const results = (credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results;
  const first = results?.first;
  if (!first || first.byteLength < 32) return null;
  return hexFromBytes(new Uint8Array(first).slice(0, 32));
}

/**
 * The salt for one guardian, derived from the master secret and the guardian's
 * own authority. Keying on the authority rather than a position means the salts
 * do not shift when guardians are reordered, added, or removed — only the
 * guardian that actually changed gets a different leaf.
 */
/** @deprecated Compatibility helper for an already-committed legacy root. */
export function deriveGuardianSalt(master: GuardianSaltMaster, descriptor: GuardianDescriptor): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 master, bytes32 info, bytes32 authority"),
    [master, keccak256(stringToHex(PRF_INFO)), keccak256(stringToHex(guardianAuthority(descriptor)))]
  ));
}

/** Apply derived salts to a roster, so the set rebuilds identically anywhere the
 * passkey is available. */
/** @deprecated Never use for a new or rotated guardian epoch. */
export function withDerivedSalts(entries: readonly RosterEntry[], master: GuardianSaltMaster): readonly RosterEntry[] {
  return Object.freeze(entries.map(entry => Object.freeze({
    ...entry,
    descriptor: Object.freeze({ ...entry.descriptor, salt: deriveGuardianSalt(master, entry.descriptor) })
  })));
}

function bytesFromHex(value: Hex): Uint8Array<ArrayBuffer> {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("credential id is not valid hex");
  const pairs = value.slice(2).match(/../g) ?? [];
  const output = new Uint8Array(pairs.length);
  for (let index = 0; index < pairs.length; index += 1) output[index] = Number.parseInt(pairs[index]!, 16);
  return output;
}

function hexFromBytes(value: Uint8Array): Hex {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
