import type { Address, Hex } from "@loom/core";
import { deriveAccountAddress } from "@loom/core/account";
import { P256ValidatorAbi } from "@loom/core/abi";
import { encodeAbiParameters, encodeFunctionData, keccak256, sha256, stringToHex } from "viem";
import type { AccountHandle } from "../../types";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const LEGACY_ACCOUNTS_KEY = "loom.passkey-wallet.accounts";
const LEGACY_WALLET_KEY = "loom.passkey-wallet.handle";
const LEGACY_DEPLOYMENT_KEY = "loom.passkey-wallet.deployment";
const LEGACY_GUARDIAN_ROOT = keccak256(stringToHex("passkey-wallet-web.guardians"));
const LEGACY_CONFIG_HASH = keccak256(stringToHex("passkey-wallet-web.config"));

export interface WalletDeployment {
  readonly chainId: number;
  readonly entryPoint: Address;
  readonly factory: Address;
  readonly implementation: Address;
  readonly validator: Address;
  readonly policyHook: Address;
  readonly proxyCreationCode: Hex;
  /** Present only when the deployment publishes guardian recovery. */
  readonly recoveryModule?: Address;
  /** Guardian verifier addresses this deployment provides, by guardian kind. */
  readonly guardianVerifiers?: { readonly ecdsa?: Address; readonly erc1271?: Address; readonly p256?: Address };
}

export interface RegisteredPasskey {
  readonly credentialId: Hex;
  readonly publicKey: { readonly x: Hex; readonly y: Hex };
}

export async function loadWalletDeployment(
  request: typeof fetch = fetch,
  source = "/sepolia.deployment.json"
): Promise<WalletDeployment> {
  const response = await request(source, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`deployment configuration returned ${response.status}`);
  return validateDeployment(await response.json());
}

export async function registerBrowserPasskey(label: string): Promise<RegisteredPasskey> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser does not support passkeys.");
  const rpId = window.location.hostname;
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: rpId, name: "Loom" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none"
    }
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("Passkey registration returned an unsupported credential.");
  }
  const spki = credential.response.getPublicKey();
  if (!spki) throw new Error("The authenticator did not expose the P-256 public key.");
  const point = new Uint8Array(spki).slice(-65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error("Expected an uncompressed P-256 public key.");
  return Object.freeze({
    credentialId: hex(new Uint8Array(credential.rawId)),
    publicKey: Object.freeze({ x: hex(point.slice(1, 33)), y: hex(point.slice(33, 65)) })
  });
}

export async function authenticateBrowserAccount(handle: AccountHandle): Promise<void> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser does not support passkeys.");
  if (window.location.origin !== handle.origin || window.location.hostname !== handle.rpId) {
    throw new Error("This wallet belongs to a different passkey origin.");
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: handle.rpId,
      allowCredentials: [{ type: "public-key", id: hexBytes(handle.credentialId) }],
      userVerification: "required",
      timeout: 60_000
    }
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("Passkey authentication returned an unsupported credential.");
  }
  await verifyBrowserAuthentication(handle, challenge, {
    credentialId: new Uint8Array(credential.rawId),
    authenticatorData: new Uint8Array(credential.response.authenticatorData),
    clientDataJSON: new Uint8Array(credential.response.clientDataJSON),
    signature: new Uint8Array(credential.response.signature)
  });
}

export async function verifyBrowserAuthentication(
  handle: AccountHandle,
  challenge: Uint8Array,
  assertion: {
    readonly credentialId: Uint8Array;
    readonly authenticatorData: Uint8Array;
    readonly clientDataJSON: Uint8Array;
    readonly signature: Uint8Array;
  },
  cryptography: Pick<Crypto, "subtle"> = crypto
): Promise<void> {
  if (!equalBytes(assertion.credentialId, hexBytes(handle.credentialId))) throw new Error("The selected passkey does not belong to this wallet.");
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { client = JSON.parse(new TextDecoder().decode(assertion.clientDataJSON)); }
  catch { throw new Error("Passkey client data is invalid."); }
  if (client.type !== "webauthn.get") throw new Error("Passkey response type is invalid.");
  if (client.challenge !== base64Url(challenge)) throw new Error("Passkey challenge does not match this login.");
  if (client.origin !== handle.origin || client.crossOrigin === true) throw new Error("Passkey origin does not match this wallet.");
  if (assertion.authenticatorData.length < 37) throw new Error("Passkey authenticator data is invalid.");
  const expectedRpIdHash = new Uint8Array(await cryptography.subtle.digest("SHA-256", new TextEncoder().encode(handle.rpId)));
  if (!equalBytes(assertion.authenticatorData.slice(0, 32), expectedRpIdHash)) throw new Error("Passkey RP ID does not match this wallet.");
  const flags = assertion.authenticatorData[32]!;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new Error("Passkey user verification is required.");

  const publicKey = await cryptography.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: base64Url(hexBytes(handle.publicKey.x)), y: base64Url(hexBytes(handle.publicKey.y)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const clientHash = new Uint8Array(await cryptography.subtle.digest("SHA-256", ownedBuffer(assertion.clientDataJSON)));
  const verified = await cryptography.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    ownedBuffer(derP256SignatureToRaw(assertion.signature)),
    ownedBuffer(concatBytes(assertion.authenticatorData, clientHash))
  );
  if (!verified) throw new Error("Passkey signature verification failed.");
}

export function deriveCreatedAccountHandle(input: {
  readonly label: string;
  readonly deployment: WalletDeployment;
  readonly passkey: RegisteredPasskey;
  readonly rpId: string;
  readonly origin: string;
}): AccountHandle {
  const label = input.label.trim();
  if (!label) throw new Error("Wallet name is required.");
  const { deployment, passkey } = input;
  const configHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }],
    [passkey.publicKey.x, passkey.publicKey.y, deployment.validator, deployment.policyHook]
  ));
  return deriveAccountHandle({
    ...input,
    label,
    guardianRoot: ZERO_BYTES32,
    guardianThreshold: 0,
    configHash
  });
}

export async function migrateLegacyAccountHandle(
  storage: Storage = window.localStorage,
  binding: { readonly rpId: string; readonly origin: string } = { rpId: window.location.hostname, origin: window.location.origin },
  loadFallbackDeployment: () => Promise<WalletDeployment> = () => loadWalletDeployment()
): Promise<AccountHandle | null> {
  return (await migrateLegacyAccountHandles(storage, binding, loadFallbackDeployment))[0] ?? null;
}

export async function migrateLegacyAccountHandles(
  storage: Storage = window.localStorage,
  binding: { readonly rpId: string; readonly origin: string } = { rpId: window.location.hostname, origin: window.location.origin },
  loadFallbackDeployment: () => Promise<WalletDeployment> = () => loadWalletDeployment()
): Promise<readonly AccountHandle[]> {
  const candidates: Array<{ readonly value: unknown; readonly fallbackLabel: string }> = [];
  const savedAccounts = storage.getItem(LEGACY_ACCOUNTS_KEY);
  if (savedAccounts) {
    try {
      const value: unknown = JSON.parse(savedAccounts);
      if (Array.isArray(value)) candidates.push(...value.map((entry, index) => ({ value: entry, fallbackLabel: `Previous wallet ${index + 1}` })));
    } catch { /* Keep the original collection untouched. */ }
  }
  const savedWallet = storage.getItem(LEGACY_WALLET_KEY);
  if (savedWallet) {
    try { candidates.push({ value: JSON.parse(savedWallet), fallbackLabel: "Previous wallet" }); }
    catch { /* A corrupt single record must not hide a healthy list. */ }
  }
  if (candidates.length === 0) return Object.freeze([]);

  const savedDeployment = storage.getItem(LEGACY_DEPLOYMENT_KEY);
  let deployment: WalletDeployment;
  if (savedDeployment) {
    let deploymentValue: unknown;
    try { deploymentValue = JSON.parse(savedDeployment); }
    catch { throw new Error("Previous wallet deployment is invalid; its original records were left unchanged."); }
    deployment = validateDeployment(deploymentValue);
  } else {
    deployment = await loadFallbackDeployment();
  }

  const migrated: AccountHandle[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const handle = migrateLegacyRecord(candidate.value, candidate.fallbackLabel, deployment, binding);
    if (handle && !seen.has(handle.id)) {
      seen.add(handle.id);
      migrated.push(handle);
    }
  }
  return Object.freeze(migrated);
}

function migrateLegacyRecord(
  value: unknown,
  fallbackLabel: string,
  deployment: WalletDeployment,
  binding: { readonly rpId: string; readonly origin: string }
): AccountHandle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wallet = value as Record<string, unknown>;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(wallet.credentialId)) || !wallet.publicKey || typeof wallet.publicKey !== "object") return null;
  const publicKey = wallet.publicKey as Record<string, unknown>;
  if (!bytes32(publicKey.x) || !bytes32(publicKey.y)) return null;
  const passkey = { credentialId: wallet.credentialId as Hex, publicKey: { x: publicKey.x as Hex, y: publicKey.y as Hex } };
  const label = typeof wallet.label === "string" && wallet.label.trim() && wallet.label.length <= 80
    ? wallet.label.trim()
    : fallbackLabel;

  if (wallet.recovered === true) {
    if (!address(wallet.account) || !address(wallet.validator)) return null;
    const account = wallet.account as Address;
    return Object.freeze({
      version: 1,
      kind: "recovered",
      id: `${deployment.chainId}:${account.toLowerCase()}`,
      label,
      account,
      chainId: deployment.chainId,
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      rpId: binding.rpId,
      origin: binding.origin,
      validator: wallet.validator as Address
    });
  }

  const rootWasMissing = wallet.guardianRoot === undefined;
  const guardianRoot = rootWasMissing ? LEGACY_GUARDIAN_ROOT : wallet.guardianRoot;
  const guardianThreshold = rootWasMissing ? 1 : wallet.guardianThreshold;
  if (!bytes32(guardianRoot) || !Number.isInteger(guardianThreshold) || Number(guardianThreshold) < 0 || Number(guardianThreshold) > 32) return null;
  const recoveryModule = wallet.recoveryModule;
  if (recoveryModule !== undefined && recoveryModule !== null && !address(recoveryModule)) return null;
  return deriveAccountHandle({
    label,
    deployment,
    passkey,
    rpId: binding.rpId,
    origin: binding.origin,
    guardianRoot: guardianRoot as Hex,
    guardianThreshold: Number(guardianThreshold),
    ...(recoveryModule == null ? {} : { recoveryModule: recoveryModule as Address }),
    configHash: LEGACY_CONFIG_HASH
  });
}

function deriveAccountHandle(input: {
  readonly label: string;
  readonly deployment: WalletDeployment;
  readonly passkey: RegisteredPasskey;
  readonly rpId: string;
  readonly origin: string;
  readonly guardianRoot: Hex;
  readonly guardianThreshold: number;
  readonly recoveryModule?: Address;
  readonly configHash: Hex;
}): AccountHandle {
  const { deployment, passkey } = input;
  const rpIdHash = sha256(stringToHex(input.rpId));
  const originHash = keccak256(stringToHex(input.origin));
  const salt = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [passkey.publicKey.x, passkey.publicKey.y]
  ));
  const account = deriveAccountAddress({
    factory: deployment.factory,
    implementation: deployment.implementation,
    proxyCreationCode: deployment.proxyCreationCode,
    salt,
    config: {
      entryPoint: deployment.entryPoint,
      guardianRoot: input.guardianRoot,
      guardianThreshold: input.guardianThreshold,
      configHash: input.configHash,
      modules: [
        { moduleTypeId: 4n, module: deployment.policyHook, initData: "0x" },
        ...(input.recoveryModule ? [{ moduleTypeId: 5n, module: input.recoveryModule, initData: "0x" as Hex }] : []),
        {
          moduleTypeId: 1n,
          module: deployment.validator,
          initData: encodeFunctionData({
            abi: P256ValidatorAbi,
            functionName: "initialize",
            args: [passkey.publicKey.x, passkey.publicKey.y, rpIdHash, originHash, deployment.policyHook]
          })
        }
      ]
    }
  });
  return Object.freeze({
    version: 1,
    kind: "derived",
    id: `${deployment.chainId}:${account.toLowerCase()}`,
    label: input.label,
    account,
    chainId: deployment.chainId,
    credentialId: passkey.credentialId,
    publicKey: passkey.publicKey,
    rpId: input.rpId,
    origin: input.origin,
    salt,
    creation: Object.freeze({
      guardianRoot: input.guardianRoot,
      guardianThreshold: input.guardianThreshold,
      ...(input.recoveryModule ? { recoveryModule: input.recoveryModule } : {})
    })
  });
}

function validateDeployment(value: unknown): WalletDeployment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment configuration is invalid");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.chainId) || Number(record.chainId) <= 0) throw new Error("deployment chain is invalid");
  for (const field of ["entryPoint", "factory", "implementation", "validator", "policyHook"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(record[field]))) throw new Error(`deployment ${field} is invalid`);
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(record.proxyCreationCode))) throw new Error("deployment proxy creation code is invalid");
  // Recovery is optional in a deployment, but a malformed entry must fail rather
  // than be silently dropped: it would present an account as unprotectable.
  if (record.recoveryModule !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(String(record.recoveryModule))) {
    throw new Error("deployment recovery module is invalid");
  }
  const verifiers = parseGuardianVerifiers(record.guardianVerifiers);
  return Object.freeze({
    chainId: Number(record.chainId),
    entryPoint: record.entryPoint as Address,
    factory: record.factory as Address,
    implementation: record.implementation as Address,
    validator: record.validator as Address,
    policyHook: record.policyHook as Address,
    proxyCreationCode: record.proxyCreationCode as Hex,
    ...(record.recoveryModule === undefined ? {} : { recoveryModule: record.recoveryModule as Address }),
    ...(verifiers ? { guardianVerifiers: verifiers } : {})
  });
}

function parseGuardianVerifiers(value: unknown): WalletDeployment["guardianVerifiers"] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("deployment guardian verifiers are invalid");
  const record = value as Record<string, unknown>;
  const verifiers: Record<string, Address> = {};
  for (const kind of ["ecdsa", "erc1271", "p256"] as const) {
    const candidate = record[kind];
    if (candidate === undefined || candidate === null) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(candidate))) throw new Error(`deployment ${kind} guardian verifier is invalid`);
    verifiers[kind] = candidate as Address;
  }
  return Object.keys(verifiers).length > 0 ? Object.freeze(verifiers) : null;
}

function hex(value: Uint8Array): Hex {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function bytes32(value: unknown): boolean { return /^0x[0-9a-fA-F]{64}$/.test(String(value)); }
function address(value: unknown): boolean { return /^0x[0-9a-fA-F]{40}$/.test(String(value)); }

function hexBytes(value: Hex): Uint8Array<ArrayBuffer> {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("Passkey credential metadata is invalid.");
  const pairs = value.slice(2).match(/../g) ?? [];
  const output = new Uint8Array(pairs.length);
  for (let index = 0; index < pairs.length; index += 1) output[index] = Number.parseInt(pairs[index]!, 16);
  return output;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; }
  return output;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(value.length);
  output.set(value);
  return output.buffer;
}

function derP256SignatureToRaw(signature: Uint8Array): Uint8Array {
  if (signature.length < 8 || signature[0] !== 0x30 || signature[1] !== signature.length - 2) throw new Error("Passkey signature encoding is invalid.");
  let offset = 2;
  const integer = (): Uint8Array => {
    if (signature[offset] !== 0x02) throw new Error("Passkey signature encoding is invalid.");
    const length = signature[offset + 1];
    if (length === undefined || length < 1 || length > 33 || offset + 2 + length > signature.length) throw new Error("Passkey signature encoding is invalid.");
    let value = signature.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    if (value.length === 33) {
      if (value[0] !== 0 || (value[1]! & 0x80) === 0) throw new Error("Passkey signature encoding is invalid.");
      value = value.slice(1);
    } else if ((value[0]! & 0x80) !== 0 || (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0)) {
      throw new Error("Passkey signature encoding is invalid.");
    }
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = integer();
  const s = integer();
  if (offset !== signature.length) throw new Error("Passkey signature encoding is invalid.");
  return concatBytes(r, s);
}
