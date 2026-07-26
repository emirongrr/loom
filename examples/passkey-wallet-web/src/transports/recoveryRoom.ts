export interface EncryptedMailbox {
  put(id: string, ciphertext: Uint8Array, expiresAt: number): Promise<void>;
  take(id: string): Promise<Uint8Array | null>;
}

export interface RecoveryRoom<T> {
  publish(value: T, expiresAt: number): Promise<{ roomId: string; key: string }>;
  collect(roomId: string, key: string): Promise<T | null>;
}

export function createEncryptedRecoveryRoom<T>(mailbox: EncryptedMailbox): RecoveryRoom<T> {
  return Object.freeze({
    async publish(value: T, expiresAt: number) {
      const roomId = crypto.randomUUID();
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(JSON.stringify({ expiresAt, value }));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(roomId) }, key, plaintext));
      const blob = new Uint8Array(iv.length + encrypted.length);
      blob.set(iv); blob.set(encrypted, iv.length);
      await mailbox.put(roomId, blob, expiresAt);
      return { roomId, key: base64(rawKey) };
    },
    async collect(roomId: string, encodedKey: string) {
      if (!/^[0-9a-f-]{36}$/iu.test(roomId)) throw new Error("invalid recovery room id");
      const blob = await mailbox.take(roomId);
      if (!blob) return null;
      const key = await crypto.subtle.importKey("raw", buffer(unbase64(encodedKey)), "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(blob.slice(0, 12)), additionalData: new TextEncoder().encode(roomId) }, key, buffer(blob.slice(12)));
      const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as { expiresAt: number; value: T };
      if (decoded.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("recovery room payload expired");
      return decoded.value;
    }
  });
}

export function createMemoryMailbox(): EncryptedMailbox {
  const messages = new Map<string, { value: Uint8Array; expiresAt: number }>();
  return Object.freeze({
    async put(id: string, ciphertext: Uint8Array, expiresAt: number) { messages.set(id, { value: ciphertext.slice(), expiresAt }); },
    async take(id: string) {
      const item = messages.get(id);
      if (!item) return null;
      messages.delete(id);
      return item.expiresAt <= Math.floor(Date.now() / 1000) ? null : item.value.slice();
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
