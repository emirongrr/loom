/**
 * A guardian list that can travel between your own devices, and nowhere else.
 *
 * The backup was a plain JSON file whose own download notice had to say "keep
 * it private: it names your guardians". That is the most sensitive thing this
 * wallet holds -- not funds, but who is connected to whom -- and it was leaving
 * the device readable by anyone who later touched the file.
 *
 * The account's own passkey unlocks it. WebAuthn's PRF extension derives a
 * stable secret from the credential, so opening the wallet opens the file, and
 * nothing else does. Where the passkey syncs between a person's devices, so
 * does the ability to read this -- which is the whole point, and why there is
 * no second secret to remember and lose.
 *
 * Not every authenticator offers PRF. Those fall back to a passphrase, and the
 * file says which one is protecting it so the reader is asked for the right
 * thing rather than told the wrong one failed.
 *
 * Where the file goes is the owner's choice: a drive they already trust, a USB
 * stick, a QR between two of their own screens. Loom is not one of those places
 * and does not become one. A hosted store would learn who protects whom and
 * when they looked -- exactly the registry this project refuses to run,
 * encrypted contents or not.
 */
const FORMAT = "loom.guardian-roster.encrypted";
const VERSION = 1;
/** Deliberately slow, and only used when a passphrase is the only secret. */
const PASSPHRASE_ITERATIONS = 310_000;

export type RosterProtection = "passkey" | "passphrase";

export interface EncryptedRoster {
  readonly format: typeof FORMAT;
  readonly version: typeof VERSION;
  readonly protectedBy: RosterProtection;
  readonly kdf: "PBKDF2-SHA256" | "HKDF-SHA256";
  readonly iterations: number;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
  /** Which account this belongs to, so a wrong file is refused before unlocking. */
  readonly account: string;
  readonly chainId: number;
}

export class RosterTransferError extends Error {}

/** The secret the file is locked with, and how the reader will be asked for it. */
export type RosterKeySource =
  | { readonly kind: "passkey"; readonly secret: Uint8Array }
  | { readonly kind: "passphrase"; readonly passphrase: string };

export async function encryptRoster(input: {
  readonly backup: unknown;
  readonly account: string;
  readonly chainId: number;
  readonly key: RosterKeySource;
  readonly salt?: Uint8Array;
  readonly subtle?: SubtleCrypto;
  readonly randomBytes?: (length: number) => Uint8Array;
}): Promise<EncryptedRoster> {
  const subtle = input.subtle ?? crypto.subtle;
  const random = input.randomBytes ?? defaultRandom;
  // The passkey salt is chosen by the caller and reused at open time: PRF only
  // reproduces the same secret when asked the same question.
  const salt = input.salt ?? random(16);
  const iv = random(12);
  const key = await deriveKey(subtle, input.key, salt, PASSPHRASE_ITERATIONS);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv: view(iv), additionalData: view(bind(input.account, input.chainId)) },
    key,
    view(new TextEncoder().encode(JSON.stringify(input.backup)))
  );
  return Object.freeze({
    format: FORMAT,
    version: VERSION,
    protectedBy: input.key.kind,
    kdf: input.key.kind === "passkey" ? "HKDF-SHA256" as const : "PBKDF2-SHA256" as const,
    iterations: input.key.kind === "passkey" ? 0 : PASSPHRASE_ITERATIONS,
    salt: base64(salt),
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
    account: input.account.toLowerCase(),
    chainId: input.chainId
  });
}

export async function decryptRoster(input: {
  readonly file: unknown;
  readonly account: string;
  readonly chainId: number;
  readonly key: RosterKeySource;
  readonly subtle?: SubtleCrypto;
}): Promise<unknown> {
  const file = parseEncryptedRoster(input.file);
  // Refused before the secret is tried, so a file for another account fails
  // with the reason rather than as a wrong passphrase.
  if (file.account !== input.account.toLowerCase()) {
    throw new RosterTransferError("This backup belongs to a different account.");
  }
  if (file.chainId !== input.chainId) {
    throw new RosterTransferError("This backup belongs to a different chain.");
  }
  if (file.protectedBy !== input.key.kind) {
    throw new RosterTransferError(file.protectedBy === "passkey"
      ? "This backup is unlocked by the account's passkey, not a passphrase."
      : "This backup is unlocked by a passphrase, not the account's passkey.");
  }
  const subtle = input.subtle ?? crypto.subtle;
  const key = await deriveKey(subtle, input.key, unbase64(file.salt), file.iterations || PASSPHRASE_ITERATIONS);
  try {
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: view(unbase64(file.iv)), additionalData: view(bind(file.account, file.chainId)) },
      key,
      view(unbase64(file.ciphertext))
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    // AES-GCM does not distinguish a wrong key from a tampered file, and
    // guessing which would be worse than saying so.
    throw new RosterTransferError(file.protectedBy === "passkey"
      ? "That passkey does not open this backup, or the file has been altered."
      : "The passphrase does not open this backup, or the file has been altered.");
  }
}

/** The salt a passkey-protected file is bound to, so opening asks the same question. */
export function rosterPrfSalt(file: EncryptedRoster): Uint8Array {
  return unbase64(file.salt);
}

export function parseEncryptedRoster(value: unknown): EncryptedRoster {
  if (!value || typeof value !== "object") throw new RosterTransferError("That is not a guardian backup.");
  const file = value as Record<string, unknown>;
  if (file.format !== FORMAT || file.version !== VERSION) {
    throw new RosterTransferError("That is not an encrypted guardian backup this wallet can read.");
  }
  const protectedBy = file.protectedBy;
  if (protectedBy !== "passkey" && protectedBy !== "passphrase") {
    throw new RosterTransferError("The backup does not say what unlocks it.");
  }
  if (file.kdf !== "PBKDF2-SHA256" && file.kdf !== "HKDF-SHA256") {
    throw new RosterTransferError("Unsupported key derivation.");
  }
  const iterations = file.iterations;
  if (typeof iterations !== "number" || !Number.isInteger(iterations) || iterations < 0) {
    throw new RosterTransferError("The backup declares an invalid key-derivation cost.");
  }
  // A passphrase file naming a trivial work factor would decrypt fine and
  // protect nothing. A passkey file needs none: its secret is already random.
  if (protectedBy === "passphrase" && (iterations < 100_000 || iterations > 5_000_000)) {
    throw new RosterTransferError("The backup declares an unsafe key-derivation cost.");
  }
  for (const field of ["salt", "iv", "ciphertext", "account"] as const) {
    if (typeof file[field] !== "string" || (file[field] as string).length === 0) {
      throw new RosterTransferError(`The backup is missing ${field}.`);
    }
  }
  if (typeof file.chainId !== "number" || !Number.isInteger(file.chainId) || file.chainId <= 0) {
    throw new RosterTransferError("The backup names no chain.");
  }
  return Object.freeze({
    format: FORMAT,
    version: VERSION,
    protectedBy,
    kdf: file.kdf,
    iterations,
    salt: file.salt as string,
    iv: file.iv as string,
    ciphertext: file.ciphertext as string,
    account: (file.account as string).toLowerCase(),
    chainId: file.chainId
  });
}

/** Short passphrases are the weak point; the file is offline and unlimited. */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.trim().length === 0) return "Choose a passphrase.";
  if (passphrase.length < 12) return "Use at least 12 characters: this file can be attacked offline, without limit.";
  return null;
}

/**
 * The account and chain are authenticated alongside the ciphertext, so a file
 * cannot be relabelled for another account without the decryption failing.
 */
function bind(account: string, chainId: number): Uint8Array {
  return new TextEncoder().encode(`${FORMAT}:${chainId}:${account.toLowerCase()}`);
}

async function deriveKey(
  subtle: SubtleCrypto,
  source: RosterKeySource,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  if (source.kind === "passkey") {
    if (source.secret.length < 32) throw new RosterTransferError("The passkey returned too short a secret.");
    // HKDF rather than PBKDF2: the input is already a random secret from the
    // authenticator, so stretching it would cost time and add nothing.
    const material = await subtle.importKey("raw", view(source.secret), "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: view(salt), info: view(new TextEncoder().encode(FORMAT)) },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
  const problem = passphraseProblem(source.passphrase);
  if (problem) throw new RosterTransferError(problem);
  const material = await subtle.importKey("raw", view(new TextEncoder().encode(source.passphrase)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: view(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Web Crypto wants an ArrayBuffer-backed view, not a possibly shared one. */
const view = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const defaultRandom = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unbase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), character => character.charCodeAt(0));
