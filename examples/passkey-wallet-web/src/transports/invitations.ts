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
 * A link whose capability travels as ciphertext in the URL fragment, so it is not
 * sent to the server, does not appear in a query string, and is not written to
 * server logs or `Referer` headers. The origin is bound as additional
 * authenticated data, so a link minted for one wallet origin cannot be decrypted
 * as if it were another's.
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
      const plaintext = new TextEncoder().encode(JSON.stringify({ expiresAt, payload }));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(origin) }, key, plaintext
      ));
      const fragment = base64(new TextEncoder().encode(JSON.stringify({
        v: 1, k: base64(rawKey), i: base64(iv), c: base64(ciphertext)
      })));
      return { receipt: "encrypted-link-created", value: `${origin}${path}#cap=${fragment}` };
    },
    async receive(value: string) {
      const url = new URL(value, origin);
      if (url.origin !== origin) throw new Error("invitation link origin does not match this wallet");
      const fragment = new URLSearchParams(url.hash.slice(1)).get("cap");
      if (!fragment || fragment.length > 65_536) throw new Error("invitation link has no valid encrypted capability");
      const envelope = JSON.parse(new TextDecoder().decode(unbase64(fragment))) as { v: number; k: string; i: string; c: string };
      if (envelope.v !== 1) throw new Error("unsupported invitation envelope");
      const key = await crypto.subtle.importKey("raw", buffer(unbase64(envelope.k)), "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buffer(unbase64(envelope.i)), additionalData: new TextEncoder().encode(origin) },
        key,
        buffer(unbase64(envelope.c))
      );
      const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as { expiresAt: number; payload: T };
      if (decoded.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("invitation link expired");
      return decoded.payload;
    }
  });
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
