import type { Address, Hex } from "@loom/core";
import { deriveAccountAddress } from "@loom/core/account";
import { P256ValidatorAbi } from "@loom/core/abi";
import { encodeAbiParameters, encodeFunctionData, keccak256, sha256, stringToHex } from "viem";
import type { AccountHandle } from "../../types";
import { loadWalletDeployment, type WalletDeployment } from "../../services/deployment/deploymentProfile.ts";
export { loadWalletDeployment, type WalletDeployment } from "../../services/deployment/deploymentProfile.ts";
import {
  base64Url,
  bytesFromHex as hexBytes,
  concatBytes,
  derP256SignatureToRaw,
  equalBytes,
  hexFromBytes as hex,
  ownedBuffer
} from "../../services/webauthn/encoding.ts";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const LEGACY_ACCOUNTS_KEY = "loom.passkey-wallet.accounts";
const LEGACY_WALLET_KEY = "loom.passkey-wallet.handle";
const LEGACY_DEPLOYMENT_KEY = "loom.passkey-wallet.deployment";
const LEGACY_GUARDIAN_ROOT = keccak256(stringToHex("passkey-wallet-web.guardians"));
const LEGACY_CONFIG_HASH = keccak256(stringToHex("passkey-wallet-web.config"));

export interface RegisteredPasskey {
  readonly credentialId: Hex;
  readonly publicKey: { readonly x: Hex; readonly y: Hex };
}

/**
 * @param account The account this passkey will control, when it is already
 * known. Written into the credential's own name, because that is what the
 * browser's passkey picker shows and a name alone leaves several of them
 * indistinguishable at the moment one has to be chosen. A wallet being created
 * has no address yet -- it is derived from the key this call produces -- so
 * that case passes nothing and keeps the label.
 */
export async function registerBrowserPasskey(label: string, account?: string): Promise<RegisteredPasskey> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser does not support passkeys.");
  const rpId = window.location.hostname;
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: rpId, name: "Loom" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: account ? `${label} (${account.slice(0, 6)}…${account.slice(-4)})` : label,
        displayName: label
      },
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
  readonly initialGuardians?: { readonly root: Hex; readonly threshold: number };
}): AccountHandle {
  const label = input.label.trim();
  if (!label) throw new Error("Wallet name is required.");
  const { deployment, passkey } = input;
  const protectedCreation = input.initialGuardians;
  if (protectedCreation) {
    if (!deployment.recoveryModule) throw new Error("Protected creation requires a recovery module in this deployment.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(protectedCreation.root)
      || protectedCreation.root === ZERO_BYTES32
      || !Number.isInteger(protectedCreation.threshold)
      || protectedCreation.threshold < 1
      || protectedCreation.threshold > 32) {
      throw new Error("The initial guardian configuration is invalid.");
    }
  }
  const guardianRoot = protectedCreation?.root ?? ZERO_BYTES32;
  const guardianThreshold = protectedCreation?.threshold ?? 0;
  const recoveryModule = protectedCreation ? deployment.recoveryModule : undefined;
  const configHash = creationConfigHash({
    passkey,
    deployment,
    guardianRoot,
    guardianThreshold,
    ...(recoveryModule ? { recoveryModule } : {})
  });
  return deriveAccountHandle({
    ...input,
    label,
    guardianRoot,
    guardianThreshold,
    ...(recoveryModule ? { recoveryModule } : {}),
    configHash
  });
}

export interface AccountCreationConfig {
  readonly entryPoint: Address;
  readonly guardianRoot: Hex;
  readonly guardianThreshold: number;
  readonly configHash: Hex;
  readonly modules: readonly { readonly moduleTypeId: bigint; readonly module: Address; readonly initData: Hex }[];
}

/**
 * Rebuild the exact configuration this account's address was derived from.
 *
 * The handle stores the inputs rather than the configuration itself, and two
 * generations of handle used different configuration hashes, so each candidate
 * is checked by re-deriving the address. Only a configuration that reproduces
 * the account's own address is returned — deploying anything else would create a
 * different account at a different address, under the user's name.
 */
export function resolveCreationConfig(
  handle: AccountHandle,
  deployment: WalletDeployment
): AccountCreationConfig | null {
  if (handle.kind !== "derived") return null;
  const rpIdHash = sha256(stringToHex(handle.rpId));
  const originHash = keccak256(stringToHex(handle.origin));
  const basicConfigHash = creationConfigHash({
    passkey: handle,
    deployment,
    guardianRoot: ZERO_BYTES32,
    guardianThreshold: 0
  });
  const boundConfigHash = creationConfigHash({
    passkey: handle,
    deployment,
    guardianRoot: handle.creation.guardianRoot,
    guardianThreshold: handle.creation.guardianThreshold,
    ...(handle.creation.recoveryModule ? { recoveryModule: handle.creation.recoveryModule } : {})
  });
  const candidates: Hex[] = [...new Set([boundConfigHash, basicConfigHash, LEGACY_CONFIG_HASH])];

  for (const configHash of candidates) {
    const config: AccountCreationConfig = {
      entryPoint: deployment.entryPoint,
      guardianRoot: handle.creation.guardianRoot,
      guardianThreshold: handle.creation.guardianThreshold,
      configHash,
      modules: [
        { moduleTypeId: 4n, module: deployment.policyHook, initData: "0x" },
        ...(handle.creation.recoveryModule ? [{ moduleTypeId: 5n, module: handle.creation.recoveryModule, initData: "0x" as Hex }] : []),
        {
          moduleTypeId: 1n,
          module: deployment.validator,
          initData: encodeFunctionData({
            abi: P256ValidatorAbi,
            functionName: "initialize",
            args: [handle.publicKey.x, handle.publicKey.y, rpIdHash, originHash, deployment.policyHook]
          })
        }
      ]
    };
    const derived = deriveAccountAddress({
      factory: deployment.factory,
      implementation: deployment.implementation,
      proxyCreationCode: deployment.proxyCreationCode,
      salt: handle.salt,
      config
    });
    if (derived.toLowerCase() === handle.account.toLowerCase()) return Object.freeze(config);
  }
  return null;
}

function creationConfigHash(input: {
  readonly passkey: RegisteredPasskey;
  readonly deployment: WalletDeployment;
  readonly guardianRoot: Hex;
  readonly guardianThreshold: number;
  readonly recoveryModule?: Address;
}): Hex {
  if (input.recoveryModule) {
    return keccak256(encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "uint8" }, { type: "address" }
      ],
      [
        input.passkey.publicKey.x,
        input.passkey.publicKey.y,
        input.deployment.validator,
        input.deployment.policyHook,
        input.guardianRoot,
        input.guardianThreshold,
        input.recoveryModule
      ]
    ));
  }
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }],
    [input.passkey.publicKey.x, input.passkey.publicKey.y, input.deployment.validator, input.deployment.policyHook]
  ));
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
    deployment = validateLegacyDeployment(deploymentValue);
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

function validateLegacyDeployment(value: unknown): WalletDeployment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Previous wallet deployment is invalid; its original records were left unchanged.");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.chainId) || Number(record.chainId) <= 0) throw new Error("Previous wallet deployment is invalid; its original records were left unchanged.");
  for (const field of ["entryPoint", "factory", "implementation", "validator", "policyHook"] as const) if (!address(record[field])) throw new Error("Previous wallet deployment is invalid; its original records were left unchanged.");
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(record.proxyCreationCode))) throw new Error("Previous wallet deployment is invalid; its original records were left unchanged.");
  if (record.recoveryModule !== undefined && !address(record.recoveryModule)) throw new Error("Previous wallet deployment is invalid; its original records were left unchanged.");
  const placeholder = `0x${"00".repeat(32)}` as Hex;
  return Object.freeze({
    chainId: Number(record.chainId),
    entryPoint: record.entryPoint as Address,
    factory: record.factory as Address,
    implementation: record.implementation as Address,
    validator: record.validator as Address,
    policyHook: record.policyHook as Address,
    proxyCreationCode: record.proxyCreationCode as Hex,
    runtimeCodeHashes: { entryPoint: placeholder, factory: placeholder, implementation: placeholder, validator: placeholder, policyHook: placeholder },
    ...(record.recoveryModule === undefined ? {} : { recoveryModule: record.recoveryModule as Address })
  });
}

function bytes32(value: unknown): boolean { return /^0x[0-9a-fA-F]{64}$/.test(String(value)); }
function address(value: unknown): boolean { return /^0x[0-9a-fA-F]{40}$/.test(String(value)); }

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
