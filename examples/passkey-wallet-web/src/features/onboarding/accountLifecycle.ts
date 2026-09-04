import type { Address, Hex } from "@loom/core";
import { deriveAccountAddress } from "@loom/core/account";
import { P256ValidatorAbi } from "@loom/core/abi";
import { encodeAbiParameters, encodeFunctionData, keccak256, sha256, stringToHex } from "viem";
import type { AccountHandle, PasskeyBackupObservation } from "../../types";
import type { WalletDeployment } from "../../services/deployment/deploymentProfile.ts";
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
import { encodeAccountUserHandle } from "./passkeyUserHandle.ts";
import { passkeyBackupState, verifyPasskeyAssertion } from "@loom/sdk/account-discovery";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export interface RegisteredPasskey {
  readonly credentialId: Hex;
  readonly publicKey: { readonly x: Hex; readonly y: Hex };
  /** Stable RP account handle, also used as this account's CREATE2 salt. */
  readonly accountHandle: Hex;
  /** The opaque RP-scoped identity written into the discoverable credential. */
  readonly userHandle: Hex;
  /** WebAuthn BE flag: this credential source can be backed up/synced. */
  readonly backupEligible: boolean;
  /** WebAuthn BS flag at registration time: a backup currently exists. */
  readonly backedUp: boolean;
}

/**
 * The stable account handle is created before the first credential and reused by a
 * recovery credential. It locates the account through the factory registry but
 * never grants authority; the live validator key remains authoritative.
 */
export async function registerBrowserPasskey(
  label: string,
  accountHandle: Hex,
  chainId: number,
  factory: Address,
  account?: Address
): Promise<RegisteredPasskey> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser does not support passkeys.");
  const rpId = window.location.hostname;
  const userId = encodeAccountUserHandle(chainId, factory, accountHandle);
  const accountSuffix = account ? `${account.slice(0, 6)}…${account.slice(-4)} · Chain ${chainId}` : "New wallet";
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: rpId, name: "Loom" },
      user: {
        // The registry resolves this opaque account handle, then the live validator
        // proves whether the credential still controls the resolved account.
        id: ownedBuffer(userId),
        name: account ? `loom:${chainId}:${account.toLowerCase()}` : `loom:${chainId}:${accountHandle.slice(2, 14)}`,
        displayName: `${label} · ${accountSuffix}`
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      // "Find with a passkey" starts with no credential id. That promise is
      // only true for a discoverable credential, so preferred is too weak.
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
      extensions: { credProps: true },
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
  const backup = credentialBackupState(new Uint8Array(credential.response.getAuthenticatorData()));
  return Object.freeze({
    credentialId: hex(new Uint8Array(credential.rawId)),
    publicKey: Object.freeze({ x: hex(point.slice(1, 33)), y: hex(point.slice(33, 65)) }),
    accountHandle,
    userHandle: hex(userId),
    ...backup
  });
}

/**
 * Prove that a credential returned by registration is immediately usable and
 * still carries the exact v3 locator that was written into it. Recovery must
 * complete this second ceremony before its public key can enter a validator.
 */
export async function assertRegisteredBrowserPasskey(input: {
  readonly passkey: RegisteredPasskey;
  readonly rpId: string;
  readonly origin: string;
}): Promise<PasskeyBackupObservation> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser does not support passkeys.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: input.rpId,
      userVerification: "required",
      timeout: 60_000
    }
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("Recovery passkey authentication returned an unsupported credential.");
  }
  if (!equalBytes(new Uint8Array(credential.rawId), hexBytes(input.passkey.credentialId))) {
    throw new Error("The asserted credential is not the recovery passkey that was just created.");
  }
  if (!credential.response.userHandle) {
    throw new Error("The recovery passkey assertion did not return its Loom account handle.");
  }
  const result = await verifyPasskeyAssertion({
    rpId: input.rpId,
    origin: input.origin,
    challenge: hex(challenge),
    expectedUserHandle: input.passkey.userHandle,
    publicKey: input.passkey.publicKey,
    assertion: {
      credentialId: hex(new Uint8Array(credential.rawId)),
      userHandle: hex(new Uint8Array(credential.response.userHandle)),
      authenticatorData: hex(new Uint8Array(credential.response.authenticatorData)),
      clientDataJSON: hex(new Uint8Array(credential.response.clientDataJSON)),
      signature: hex(new Uint8Array(credential.response.signature))
    }
  });
  if (!result.valid) {
    if (result.reason === "user-handle") throw new Error("The recovery passkey returned a different Loom account handle.");
    if (result.reason === "ceremony") throw new Error("The recovery passkey did not prove the expected RP, origin, challenge, presence, and user verification.");
    throw new Error("The recovery passkey assertion does not verify with its newly registered public key.");
  }
  return backupObservation(
    credentialBackupState(new Uint8Array(credential.response.authenticatorData)),
    "assertion"
  );
}

export function backupObservation(
  state: Pick<RegisteredPasskey, "backupEligible" | "backedUp">,
  source: PasskeyBackupObservation["source"],
  observedAt = Date.now()
): PasskeyBackupObservation {
  return Object.freeze({ ...state, observedAt, source });
}

/** Parse the WebAuthn BE/BS flags and reject the forbidden BS=1, BE=0 state. */
export function credentialBackupState(authenticatorData: Uint8Array): {
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
} {
  try {
    return passkeyBackupState(hex(authenticatorData));
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : "Passkey authenticator data is invalid.");
  }
}

/** Opportunistically improve the authenticator's picker label after CREATE2
 * has produced the address. WebAuthn L3 makes this metadata mutable, but older
 * clients may not implement the signal and discovery must never depend on it. */
export async function updateBrowserPasskeyLabel(input: {
  readonly userHandle: Hex;
  readonly label: string;
  readonly account: Address;
  readonly chainId: number;
}): Promise<void> {
  const credentialApi = PublicKeyCredential as typeof PublicKeyCredential & {
    signalCurrentUserDetails?: (input: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
  };
  if (!credentialApi.signalCurrentUserDetails) return;
  await credentialApi.signalCurrentUserDetails({
    rpId: window.location.hostname,
    userId: base64Url(hexBytes(input.userHandle)),
    name: `loom:${input.chainId}:${input.account.toLowerCase()}`,
    displayName: `${input.label} · ${input.account.slice(0, 6)}…${input.account.slice(-4)} · Chain ${input.chainId}`
  }).catch(() => undefined);
}

export async function authenticateBrowserAccount(handle: AccountHandle): Promise<PasskeyBackupObservation> {
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
  return await verifyBrowserAuthentication(handle, challenge, {
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
): Promise<PasskeyBackupObservation> {
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
  return backupObservation(credentialBackupState(assertion.authenticatorData), "assertion");
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
 * The handle stores the exact inputs rather than the expanded configuration.
 * New-generation wallets have one derivation format, so the configuration must
 * reproduce the account's own address without legacy candidate hashes.
 */
export function resolveCreationConfig(
  handle: AccountHandle,
  deployment: WalletDeployment
): AccountCreationConfig | null {
  if (handle.kind !== "derived") return null;
  const rpIdHash = sha256(stringToHex(handle.rpId));
  const originHash = keccak256(stringToHex(handle.origin));
  const configHash = creationConfigHash({
    passkey: handle,
    deployment,
    guardianRoot: handle.creation.guardianRoot,
    guardianThreshold: handle.creation.guardianThreshold,
    ...(handle.creation.recoveryModule ? { recoveryModule: handle.creation.recoveryModule } : {})
  });
  const config: AccountCreationConfig = {
    entryPoint: deployment.entryPoint,
    guardianRoot: handle.creation.guardianRoot,
    guardianThreshold: handle.creation.guardianThreshold,
    configHash,
    modules: [
      { moduleTypeId: 4n, module: deployment.policyHook, initData: "0x" },
      ...(handle.creation.recoveryModule ? [{ moduleTypeId: 5n, module: handle.creation.recoveryModule, initData: "0x" as Hex }] : []),
      ...(deployment.migrationModule ? [{ moduleTypeId: 6n, module: deployment.migrationModule, initData: "0x" as Hex }] : []),
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
    salt: handle.accountHandle,
    config
  });
  return derived.toLowerCase() === handle.account.toLowerCase() ? Object.freeze(config) : null;
}

function creationConfigHash(input: {
  readonly passkey: Pick<RegisteredPasskey, "publicKey">;
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
  const accountHandle = passkey.accountHandle;
  const account = deriveAccountAddress({
    factory: deployment.factory,
    implementation: deployment.implementation,
    proxyCreationCode: deployment.proxyCreationCode,
    salt: accountHandle,
    config: {
      entryPoint: deployment.entryPoint,
      guardianRoot: input.guardianRoot,
      guardianThreshold: input.guardianThreshold,
      configHash: input.configHash,
      modules: [
        { moduleTypeId: 4n, module: deployment.policyHook, initData: "0x" },
        ...(input.recoveryModule ? [{ moduleTypeId: 5n, module: input.recoveryModule, initData: "0x" as Hex }] : []),
        ...(deployment.migrationModule ? [{ moduleTypeId: 6n, module: deployment.migrationModule, initData: "0x" as Hex }] : []),
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
    version: 3,
    kind: "derived",
    id: `${deployment.chainId}:${account.toLowerCase()}`,
    label: input.label,
    account,
    chainId: deployment.chainId,
    credentialId: passkey.credentialId,
    publicKey: passkey.publicKey,
    rpId: input.rpId,
    origin: input.origin,
    passkeyBackup: backupObservation(passkey, "registration"),
    accountHandle,
    creation: Object.freeze({
      guardianRoot: input.guardianRoot,
      guardianThreshold: input.guardianThreshold,
      ...(input.recoveryModule ? { recoveryModule: input.recoveryModule } : {})
    })
  });
}
