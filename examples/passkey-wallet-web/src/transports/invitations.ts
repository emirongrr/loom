import { validateGuardianInvite, type GuardianInviteV1 } from "@loom/sdk/recovery";

/** Delivery for a guardian capability. Transport is replaceable and never trusted:
 * whatever arrives is validated against the account before it is accepted. */
export interface InvitationTransport<T> {
  readonly kind: "encrypted-link";
  deliver(payload: T, options?: { expiresAt?: number }): Promise<{ receipt: string; value: string }>;
  receive(value: string): Promise<T>;
}

export async function receiveGuardianInvite(
  value: string,
  transport: InvitationTransport<GuardianInviteV1>,
  now = Math.floor(Date.now() / 1000)
): Promise<GuardianInviteV1> {
  return validateGuardianInvite(await transport.receive(value), { now });
}

/**
 * A link that carries a capability in its URL fragment.
 *
 * What this actually provides, stated exactly, because the previous description
 * claimed more than the code does:
 *
 * - **The fragment is never sent to a server.** It is absent from the request
 *   line, from server logs, and from `Referer`. This is the real property, and
 *   it holds whether or not the payload is encrypted.
 * - **The link is a bearer secret.** The AES key travels in the same fragment as
 *   the ciphertext, so anyone who holds the link can read and copy the capability: the
 *   messaging app it was pasted into, a screenshot, a clipboard manager, a synced
 *   browser history. The encryption does not change that and must not be
 *   described as if it did. The capability does not include the guardian signing
 *   key, and acceptance remains bound to the matching guardian wallet.
 * - **The origin as AAD catches accidents, not attackers.** A link minted for
 *   another wallet origin fails to decrypt cleanly rather than being parsed as a
 *   capability. It is not a defence: the AAD is the origin string, which is not
 *   secret and sits in the link's own prefix, so anyone holding the link can
 *   supply it.
 *
 * The controls that do bound this are elsewhere and are real: the invite expires,
 * acceptance validates the capability against the opening wallet's own account
 * (`guardianVaultScope`), and a guardian only becomes authority once the
 * account's guardian root commits to it on chain.
 *
 * A transport that wants confidentiality against a link holder has to carry the
 * key on a second channel. That is a different design, not a stricter version of
 * this one, and the README says so rather than implying this one already does it.
 */
export function createEncryptedLinkTransport<T>(options: { origin: string; path?: string }): InvitationTransport<T> {
  const origin = new URL(options.origin).origin;
  const path = options.path ?? "/guardian";
  return Object.freeze({
    kind: "encrypted-link" as const,
    async deliver(payload: T, delivery: { expiresAt?: number } = {}) {
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const expiresAt = delivery.expiresAt ?? Math.floor(Date.now() / 1000) + 86_400;
      // Compressed before encryption. A capability is mostly repeated hex and
      // JSON keys, so this is where the length actually goes: a real one falls
      // from about 1,260 bytes to 450, and the link people paste into a message
      // from roughly 2,400 characters to 700.
      const compressed = await deflate(new TextEncoder().encode(JSON.stringify({ expiresAt, payload })));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(origin) }, key, buffer(compressed)
      ));
      // Packed as bytes rather than base64 inside JSON inside base64, which was
      // encoding everything twice for no gain.
      const packed = new Uint8Array(1 + rawKey.length + iv.length + ciphertext.length);
      packed[0] = VERSION;
      packed.set(rawKey, 1);
      packed.set(iv, 1 + rawKey.length);
      packed.set(ciphertext, 1 + rawKey.length + iv.length);
      return { receipt: "encrypted-link-created", value: `${origin}${path}#cap=${base64(packed)}` };
    },
    async receive(value: string) {
      const url = new URL(value, origin);
      if (url.origin !== origin) throw new Error("invitation link origin does not match this wallet");
      const fragment = new URLSearchParams(url.hash.slice(1)).get("cap");
      if (!fragment || fragment.length > 65_536) throw new Error("invitation link has no valid encrypted capability");
      const bytes = unbase64(fragment);
      const { rawKey, iv, ciphertext, compressed } = unpack(bytes);
      const key = await crypto.subtle.importKey("raw", buffer(rawKey), "AES-GCM", false, ["decrypt"]);
      const plaintext = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buffer(iv), additionalData: new TextEncoder().encode(origin) },
        key,
        buffer(ciphertext)
      ));
      const decoded = JSON.parse(new TextDecoder().decode(compressed ? await inflate(plaintext) : plaintext)) as { expiresAt: number; payload: T };
      if (decoded.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("invitation link expired");
      return decoded.payload;
    }
  });
}


/** The packed layout. Version 1 links, already sent, still open. */
const VERSION = 2;

function unpack(bytes: Uint8Array): { rawKey: Uint8Array; iv: Uint8Array; ciphertext: Uint8Array; compressed: boolean } {
  if (bytes.length > 0 && bytes[0] === VERSION) {
    if (bytes.length < 1 + 32 + 12 + 16) throw new Error("invitation link is truncated");
    return {
      rawKey: bytes.slice(1, 33),
      iv: bytes.slice(33, 45),
      ciphertext: bytes.slice(45),
      compressed: true
    };
  }
  // Version 1: base64 of a JSON envelope holding three more base64 strings.
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { v: number; k: string; i: string; c: string };
  if (envelope.v !== 1) throw new Error("unsupported invitation envelope");
  return { rawKey: unbase64(envelope.k), iv: unbase64(envelope.i), ciphertext: unbase64(envelope.c), compressed: false };
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([buffer(bytes)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([buffer(bytes)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function unbase64(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function buffer(value: Uint8Array): ArrayBuffer { return value.slice().buffer as ArrayBuffer; }
