import type { Address, Hex } from "@loom/core";
import {
  ECDSAGuardianVerifierAbi,
  LoomAccountAbi,
  P256RecoveryValidatorFactoryAbi,
  P256ValidatorAbi,
  RecoveryManagerAbi
} from "@loom/core/abi";
import type { LoomStateReadTransport } from "./types.js";
import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex
} from "viem";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const MAX_GUARDIANS = 32;
const INVITE_VERSION = 1;
const INVITE_FIELDS = Object.freeze([
  "version", "critical", "chainId", "account", "accountAlias", "issuerLabel", "guardianSetVersion",
  "configVersion", "guardianRoot", "threshold", "guardianCount", "capabilityId", "expiresAt", "guardian", "proof", "integrity"
]);
const REQUIRED_CRITICAL_FIELDS = Object.freeze([
  "chainId", "account", "guardianSetVersion", "configVersion", "guardianRoot", "capabilityId", "expiresAt", "guardian", "proof"
]);

export type GuardianKind = "ecdsa" | "p256" | "erc1271";

interface GuardianBase {
  readonly kind: GuardianKind;
  readonly verifier: Address;
  readonly verifierCodeHash: Hex;
  readonly salt?: Hex;
}

export interface EcdsaGuardian extends GuardianBase {
  readonly kind: "ecdsa";
  readonly address: Address;
}

export interface P256Guardian extends GuardianBase {
  readonly kind: "p256";
  readonly publicKey: { readonly x: Hex; readonly y: Hex };
  readonly credentialId?: Hex;
}

export interface Erc1271Guardian extends GuardianBase {
  readonly kind: "erc1271";
  readonly account: Address;
}

export type GuardianDescriptor = EcdsaGuardian | P256Guardian | Erc1271Guardian;

export interface GuardianSetMember {
  readonly kind: GuardianKind;
  readonly verifier: Address;
  readonly verifierCodeHash: Hex;
  readonly keyCommitment: Hex;
  readonly salt: Hex;
  readonly leaf: Hex;
}

export interface GuardianSet {
  readonly root: Hex;
  readonly threshold: number;
  readonly guardians: readonly GuardianSetMember[];
  readonly layers: readonly (readonly Hex[])[];
}

export type GuardianRecoveryErrorCode =
  | "INVALID_DEPLOYMENT"
  | "DEPLOYMENT_CHAIN_MISMATCH"
  | "UNSUPPORTED_GUARDIAN_VERIFIER"
  | "GUARDIAN_CREDENTIAL_UNAVAILABLE"
  | "GUARDIAN_PROOF_MISMATCH"
  | "STALE_GUARDIAN_INVITE"
  | "DUPLICATE_GUARDIAN"
  | "INVALID_THRESHOLD"
  | "GUARDIAN_NOT_ACCEPTED"
  | "INVALID_GUARDIAN_INVITE"
  | "INVALID_GUARDIAN_SIGNATURE"
  | "INSUFFICIENT_APPROVALS"
  | "RECOVERY_NOT_CONFIGURED"
  | "RECOVERY_ALREADY_PENDING"
  | "RECOVERY_NOT_READY"
  | "RECOVERY_EXPIRED"
  | "RECOVERY_CONFIG_VERSION_MISMATCH"
  | "ACCOUNT_FROZEN"
  | "TRANSPORT_PAYLOAD_EXPIRED"
  | "INVALID_RECOVERY_REQUEST"
  | "INVALID_RECOVERY_RESPONSE"
  | "UNSUPPORTED_RECOVERED_VALIDATOR_PATH";

export * from "./recoveryProtocol.js";
export * from "./guardianCapability.js";

export class GuardianRecoveryError extends Error {
  readonly code: GuardianRecoveryErrorCode;
  readonly safeMessage: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly remediation?: string;

  constructor(
    code: GuardianRecoveryErrorCode,
    message: string,
    options: { safeMessage?: string; details?: Record<string, unknown>; remediation?: string; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GuardianRecoveryError";
    this.code = code;
    this.safeMessage = options.safeMessage ?? message;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    if (options.remediation !== undefined) this.remediation = options.remediation;
  }
}

export function createGuardianLeaf(input: GuardianDescriptor | GuardianSetMember): Hex {
  const verifier = address(input.verifier, "guardian verifier");
  const verifierCodeHash = bytes32(input.verifierCodeHash, "guardian verifier code hash");
  const salt = bytes32(input.salt, "guardian salt");
  const keyCommitment = "keyCommitment" in input
    ? bytes32(input.keyCommitment, "guardian key commitment")
    : keyCommitmentFor(input);
  if (keyCommitment === ZERO_BYTES32) fail("GUARDIAN_CREDENTIAL_UNAVAILABLE", "guardian key commitment cannot be zero");
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address verifier, bytes32 verifierCodeHash, bytes32 keyCommitment, bytes32 salt"),
    [verifier, verifierCodeHash, keyCommitment, salt]
  ));
}

export function createGuardianSet(input: {
  guardians: readonly GuardianDescriptor[];
  threshold: number;
  randomBytes?: (length: number) => Uint8Array;
}): GuardianSet {
  if (!Array.isArray(input?.guardians) || input.guardians.length === 0 || input.guardians.length > MAX_GUARDIANS) {
    fail("INVALID_THRESHOLD", `guardian count must be between 1 and ${MAX_GUARDIANS}`);
  }
  const threshold = integer(input.threshold, "guardian threshold");
  if (threshold < 1 || threshold > input.guardians.length || threshold > MAX_GUARDIANS) {
    fail("INVALID_THRESHOLD", "guardian threshold must be between one and the guardian count", {
      threshold,
      guardianCount: input.guardians.length
    });
  }
  const authority = new Map<string, number>();
  const salts = new Set<string>();
  const members = input.guardians.map((guardian, index) => {
    const keyCommitment = keyCommitmentFor(guardian);
    const authorityKey = keyCommitment.toLowerCase();
    if (authority.has(authorityKey)) {
      fail("DUPLICATE_GUARDIAN", "guardian authority appears more than once", {
        firstIndex: authority.get(authorityKey),
        duplicateIndex: index
      });
    }
    authority.set(authorityKey, index);
    const salt = bytes32(guardian.salt ?? randomSalt(input.randomBytes), `guardian[${index}].salt`);
    if (salts.has(salt)) fail("DUPLICATE_GUARDIAN", "guardian salts must be unique within a set", { duplicateIndex: index });
    salts.add(salt);
    const member: GuardianSetMember = Object.freeze({
      kind: guardian.kind,
      verifier: address(guardian.verifier, `guardian[${index}].verifier`),
      verifierCodeHash: bytes32(guardian.verifierCodeHash, `guardian[${index}].verifierCodeHash`),
      keyCommitment,
      salt,
      leaf: ZERO_BYTES32
    });
    return Object.freeze({ ...member, leaf: createGuardianLeaf(member) });
  }).sort((left, right) => compareHex(left.leaf, right.leaf));

  for (let i = 1; i < members.length; i += 1) {
    if (members[i]!.leaf === members[i - 1]!.leaf) fail("DUPLICATE_GUARDIAN", "duplicate guardian leaf");
  }

  const layers: Hex[][] = [members.map(member => member.leaf)];
  while (layers[layers.length - 1]!.length > 1) {
    const prior = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prior.length; i += 2) next.push(hashPair(prior[i]!, prior[i + 1] ?? prior[i]!));
    layers.push(next);
  }
  return Object.freeze({
    root: layers[layers.length - 1]![0]!,
    threshold,
    guardians: Object.freeze(members),
    layers: Object.freeze(layers.map(layer => Object.freeze(layer)))
  });
}

export function createGuardianProof(set: GuardianSet, guardianLeaf: Hex): readonly Hex[] {
  const leaf = bytes32(guardianLeaf, "guardian leaf");
  let index = set.layers[0]!.indexOf(leaf);
  if (index < 0) fail("GUARDIAN_PROOF_MISMATCH", "guardian leaf is not in this set");
  const proof: Hex[] = [];
  for (let level = 0; level < set.layers.length - 1; level += 1) {
    const layer = set.layers[level]!;
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    proof.push(layer[sibling] ?? layer[index]!);
    index = Math.floor(index / 2);
  }
  return Object.freeze(proof);
}

export function verifyGuardianProof(input: { root: Hex; leaf: Hex; proof: readonly Hex[] }): boolean {
  try {
    let computed = bytes32(input.leaf, "guardian leaf");
    if (!Array.isArray(input.proof) || input.proof.length > 32) return false;
    for (const sibling of input.proof) computed = hashPair(computed, bytes32(sibling, "guardian proof item"));
    return computed === bytes32(input.root, "guardian root");
  } catch {
    return false;
  }
}

export interface GuardianInviteV1 {
  readonly version: 1;
  readonly critical: readonly string[];
  readonly chainId: number;
  readonly account: Address;
  readonly accountAlias: string;
  readonly issuerLabel: string;
  readonly guardianSetVersion: number;
  readonly configVersion: string;
  readonly guardianRoot: Hex;
  readonly threshold: number;
  readonly guardianCount: number;
  readonly capabilityId: Hex;
  readonly expiresAt: number;
  readonly guardian: GuardianSetMember;
  readonly proof: readonly Hex[];
  readonly integrity: { readonly algorithm: "keccak256-canonical-json"; readonly digest: Hex };
}

export function createGuardianInvite(input: {
  set: GuardianSet;
  guardianLeaf: Hex;
  chainId: number;
  account: Address;
  accountAlias: string;
  issuerLabel: string;
  guardianSetVersion: number;
  configVersion: bigint | number | string;
  capabilityId: Hex;
  expiresAt: number;
}): GuardianInviteV1 {
  const leaf = bytes32(input.guardianLeaf, "guardian leaf");
  const guardian = input.set.guardians.find(item => item.leaf === leaf);
  if (!guardian) fail("GUARDIAN_PROOF_MISMATCH", "guardian is not in this set");
  const withoutIntegrity = {
    version: INVITE_VERSION as 1,
    critical: REQUIRED_CRITICAL_FIELDS,
    chainId: positiveInteger(input.chainId, "chainId"),
    account: address(input.account, "account"),
    accountAlias: boundedText(input.accountAlias, "account alias", 80),
    issuerLabel: boundedText(input.issuerLabel, "issuer label", 80),
    guardianSetVersion: positiveInteger(input.guardianSetVersion, "guardian set version"),
    configVersion: nonNegativeBigInt(input.configVersion, "config version").toString(),
    guardianRoot: bytes32(input.set.root, "guardian root"),
    threshold: input.set.threshold,
    guardianCount: input.set.guardians.length,
    capabilityId: bytes32(input.capabilityId, "capability id"),
    expiresAt: positiveInteger(input.expiresAt, "invite expiry"),
    guardian,
    proof: createGuardianProof(input.set, leaf)
  };
  return deepFreeze({
    ...withoutIntegrity,
    integrity: { algorithm: "keccak256-canonical-json", digest: hashCanonical(withoutIntegrity) }
  }) as GuardianInviteV1;
}

export function serializeGuardianInvite(invite: GuardianInviteV1): string {
  validateGuardianInvite(invite);
  return canonicalJson(invite);
}

export function parseGuardianInvite(
  text: string,
  expected: { chainId?: number; account?: Address; guardianRoot?: Hex; configVersion?: bigint | number | string; now?: number } = {}
): GuardianInviteV1 {
  if (typeof text !== "string" || text.length === 0 || text.length > 32_768) {
    fail("INVALID_GUARDIAN_INVITE", "guardian invite must be between 1 and 32768 characters");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (cause) {
    throw new GuardianRecoveryError("INVALID_GUARDIAN_INVITE", "guardian invite is not valid JSON", { cause });
  }
  return validateGuardianInvite(parsed, expected);
}

export function validateGuardianInvite(
  value: unknown,
  expected: { chainId?: number; account?: Address; guardianRoot?: Hex; configVersion?: bigint | number | string; now?: number } = {}
): GuardianInviteV1 {
  return normalizeGuardianInvite(value, expected, true);
}

/**
 * Validates an invitation that was already admitted into durable storage.
 * Unlike validateGuardianInvite, elapsed transport expiry is returned to the
 * caller as data so the local lifecycle can mark the record stale.
 */
export function validatePersistedGuardianInvite(value: unknown): GuardianInviteV1 {
  return normalizeGuardianInvite(value, {}, false);
}

function normalizeGuardianInvite(
  value: unknown,
  expected: { chainId?: number; account?: Address; guardianRoot?: Hex; configVersion?: bigint | number | string; now?: number },
  requireFresh: boolean
): GuardianInviteV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_GUARDIAN_INVITE", "guardian invite must be an object");
  const invite = value as Record<string, unknown>;
  const unknown = Object.keys(invite).filter(key => !INVITE_FIELDS.includes(key));
  if (unknown.length > 0) fail("INVALID_GUARDIAN_INVITE", "guardian invite contains unknown fields", { unknown });
  if (invite.version !== INVITE_VERSION) fail("INVALID_GUARDIAN_INVITE", "unsupported guardian invite version");
  if (!Array.isArray(invite.critical) || invite.critical.some(field => !REQUIRED_CRITICAL_FIELDS.includes(String(field)))) {
    fail("INVALID_GUARDIAN_INVITE", "guardian invite contains unknown critical fields");
  }
  for (const field of REQUIRED_CRITICAL_FIELDS) {
    if (!(invite.critical as unknown[]).includes(field) || !(field in invite)) {
      fail("INVALID_GUARDIAN_INVITE", `guardian invite is missing critical field ${field}`);
    }
  }
  const chainId = positiveInteger(invite.chainId, "invite chainId");
  const account = address(invite.account, "invite account");
  const guardianRoot = bytes32(invite.guardianRoot, "invite guardian root");
  const configVersion = nonNegativeBigInt(invite.configVersion, "invite config version");
  const guardian = normalizeInviteGuardian(invite.guardian);
  const proof = proofArray(invite.proof);
  if (!verifyGuardianProof({ root: guardianRoot, leaf: guardian.leaf, proof })) {
    fail("GUARDIAN_PROOF_MISMATCH", "guardian invite proof does not match its root");
  }
  const expiresAt = positiveInteger(invite.expiresAt, "invite expiry");
  if (requireFresh && expiresAt <= (expected.now ?? Math.floor(Date.now() / 1000))) {
    fail("TRANSPORT_PAYLOAD_EXPIRED", "guardian invite has expired");
  }
  if (expected.chainId !== undefined && chainId !== expected.chainId) {
    fail("DEPLOYMENT_CHAIN_MISMATCH", "guardian invite is for a different chain", { expected: expected.chainId, actual: chainId });
  }
  if (expected.account !== undefined && account !== address(expected.account, "expected account")) {
    fail("STALE_GUARDIAN_INVITE", "guardian invite is for a different account");
  }
  if (expected.guardianRoot !== undefined && guardianRoot !== bytes32(expected.guardianRoot, "expected guardian root")) {
    fail("STALE_GUARDIAN_INVITE", "guardian invite no longer matches the account guardian root");
  }
  if (expected.configVersion !== undefined && configVersion !== nonNegativeBigInt(expected.configVersion, "expected config version")) {
    fail("STALE_GUARDIAN_INVITE", "guardian invite was created for a different account configuration");
  }
  if (!invite.integrity || typeof invite.integrity !== "object") fail("INVALID_GUARDIAN_INVITE", "guardian invite integrity is missing");
  const integrity = invite.integrity as Record<string, unknown>;
  if (integrity.algorithm !== "keccak256-canonical-json") fail("INVALID_GUARDIAN_INVITE", "unsupported guardian invite integrity algorithm");
  const { integrity: _ignored, ...withoutIntegrity } = invite;
  if (bytes32(integrity.digest, "invite integrity digest") !== hashCanonical(withoutIntegrity)) {
    fail("INVALID_GUARDIAN_INVITE", "guardian invite integrity check failed");
  }
  return deepFreeze({
    ...invite,
    chainId,
    account,
    accountAlias: boundedText(invite.accountAlias, "account alias", 80),
    issuerLabel: boundedText(invite.issuerLabel, "issuer label", 80),
    guardianSetVersion: positiveInteger(invite.guardianSetVersion, "guardian set version"),
    configVersion: configVersion.toString(),
    guardianRoot,
    threshold: positiveInteger(invite.threshold, "guardian threshold"),
    guardianCount: positiveInteger(invite.guardianCount, "guardian count"),
    capabilityId: bytes32(invite.capabilityId, "capability id"),
    expiresAt,
    guardian,
    proof,
    integrity: { algorithm: "keccak256-canonical-json", digest: bytes32(integrity.digest, "invite integrity digest") }
  }) as GuardianInviteV1;
}

export interface GuardianApprovalTuple {
  readonly verifier: Address;
  readonly keyCommitment: Hex;
  readonly salt: Hex;
  readonly signature: Hex;
  readonly proof: readonly Hex[];
  readonly leaf: Hex;
}

const ACCOUNT_RECOVERY_ABI = LoomAccountAbi;
const RECOVERY_MANAGER_ABI = RecoveryManagerAbi;
const GUARDIAN_VERIFIER_ABI = ECDSAGuardianVerifierAbi;

export interface GuardianSubmitTransport {
  submit(input: {
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
    readonly permissionless: boolean;
    readonly review: GuardianActionReview;
  }): Promise<unknown>;
}

export interface GuardianRecoveryStateTransport extends LoomStateReadTransport {
  getBlockTimestamp?(): Promise<bigint>;
}

export interface GuardianActionReview {
  readonly title: string;
  readonly action: string;
  readonly account: Address;
  readonly chainId: number;
  readonly summary: string;
  readonly threshold?: number;
  readonly guardianCount?: number;
  readonly validatorChange?: { readonly from: readonly Address[]; readonly to: Address };
  readonly delaySeconds?: number;
  readonly expiresAt?: bigint;
  readonly cancellation: string;
  readonly warnings: readonly string[];
}

export interface PreparedFreeze {
  readonly kind: "guardian.freeze.prepared";
  readonly account: Address;
  readonly guardian: GuardianSetMember;
  readonly proof: readonly Hex[];
  readonly digest: Hex;
  readonly configVersion: bigint;
  readonly nonce: bigint;
  readonly review: GuardianActionReview;
}

export interface PreparedRecovery {
  readonly kind: "guardian.recovery.prepared";
  readonly account: Address;
  readonly oldValidators: readonly Address[];
  readonly oldValidatorsHash: Hex;
  readonly newValidator: Address;
  readonly initData: Hex;
  readonly initDataHash: Hex;
  readonly newGuardianSet: GuardianSet;
  readonly configVersion: bigint;
  readonly nonce: bigint;
  readonly digest: Hex;
  readonly recoveryId: Hex;
  readonly review: GuardianActionReview;
}

export interface P256RecoveryValidatorProfile {
  readonly kind: "p256";
  readonly address: Address;
  readonly runtimeCodeHash: Hex;
  readonly allowedPolicyHooks: readonly Address[];
}

export interface P256RecoveryValidatorFactoryProfile {
  readonly address: Address;
  readonly runtimeCodeHash: Hex;
  readonly validatorRuntimeCodeHash: Hex;
  readonly fallbackVerifier: Address;
  readonly allowedPolicyHooks: readonly Address[];
}

export interface PreparedP256RecoveryValidator {
  readonly validator: Address;
  readonly initDataHash: Hex;
  readonly alreadyDeployed: boolean;
  readonly deploy?: { readonly to: Address; readonly data: Hex; readonly value: 0n; readonly permissionless: true };
}

/**
 * Verify a manifest-pinned permissionless factory and prepare the deterministic
 * validator deployment for one exact recovery nonce and passkey initializer.
 */
export async function prepareP256RecoveryValidator(input: {
  readonly account: Address;
  readonly recoveryNonce: bigint;
  readonly initData: Hex;
  readonly profile: P256RecoveryValidatorFactoryProfile;
  readonly stateTransport: LoomStateReadTransport;
}): Promise<PreparedP256RecoveryValidator> {
  const account = address(input.account, "account");
  const recoveryNonce = nonNegativeBigInt(input.recoveryNonce, "recovery nonce");
  if (recoveryNonce > ((1n << 64n) - 1n)) fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "recovery nonce exceeds uint64");
  const initData = hexBytes(input.initData, "validator initialization data", 65_536);
  const initDataHash = keccak256(initData);
  const factory = address(input.profile.address, "recovery validator factory");
  const state = input.stateTransport;
  if (!state?.getCode) fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "recovery validator factory verification requires getCode");

  const factoryCode = await state.getCode({ address: factory });
  if (!factoryCode || factoryCode === "0x" || keccak256(factoryCode) !== bytes32(input.profile.runtimeCodeHash, "recovery validator factory code hash")) {
    fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "recovery validator factory does not match the trusted deployment profile");
  }

  let fallbackVerifier: Address;
  let validator: Address;
  try {
    fallbackVerifier = address(await readContract(state, factory, P256RecoveryValidatorFactoryAbi, "fallbackVerifier"), "factory fallback verifier");
    validator = address(await readContract(state, factory, P256RecoveryValidatorFactoryAbi, "getAddress", [account, recoveryNonce, initDataHash]), "recovery validator");
  } catch {
    fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "recovery validator factory could not be verified");
  }
  if (fallbackVerifier !== address(input.profile.fallbackVerifier, "trusted fallback verifier")) {
    fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "recovery validator factory fallback verifier does not match the trusted deployment profile");
  }

  const validatorCode = await state.getCode({ address: validator });
  if (validatorCode && validatorCode !== "0x") {
    if (keccak256(validatorCode) !== bytes32(input.profile.validatorRuntimeCodeHash, "recovery validator code hash")) {
      fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "deployed recovery validator code does not match the trusted deployment profile");
    }
    return Object.freeze({ validator, initDataHash, alreadyDeployed: true });
  }

  return Object.freeze({
    validator,
    initDataHash,
    alreadyDeployed: false,
    deploy: Object.freeze({
      to: factory,
      data: encodeFunctionData({ abi: P256RecoveryValidatorFactoryAbi, functionName: "deploy", args: [account, recoveryNonce, initDataHash] }),
      value: 0n,
      permissionless: true
    })
  });
}

export function createGuardianRecoveryClient(options: {
  chainId: number;
  account: Address;
  recoveryManager: Address;
  stateTransport: GuardianRecoveryStateTransport;
  submitTransport?: GuardianSubmitTransport;
  deployment?: { chainId: number; recoveryManager?: Address };
  trustedRecoveryValidators?: readonly P256RecoveryValidatorProfile[];
  recoveryValidatorFactory?: P256RecoveryValidatorFactoryProfile;
}) {
  const chainId = positiveInteger(options.chainId, "chainId");
  const account = address(options.account, "account");
  const recoveryManager = address(options.recoveryManager, "recovery manager");
  if (!options.stateTransport?.ethCall) fail("INVALID_DEPLOYMENT", "a state transport is required");
  if (options.deployment && options.deployment.chainId !== chainId) {
    fail("DEPLOYMENT_CHAIN_MISMATCH", "recovery client chain does not match deployment", { chainId, deploymentChainId: options.deployment.chainId });
  }
  if (options.deployment?.recoveryManager && address(options.deployment.recoveryManager, "deployment recovery manager") !== recoveryManager) {
    fail("INVALID_DEPLOYMENT", "recovery manager does not match deployment");
  }

  const state = options.stateTransport;
  const submit = async (to: Address, data: Hex, review: GuardianActionReview, permissionless: boolean) => {
    if (!options.submitTransport) fail("INVALID_DEPLOYMENT", "a submit transport is required for this operation", {}, "Inject a direct transaction, relayer, or bundler adapter.");
    return options.submitTransport.submit({ to, data, value: 0n, permissionless, review });
  };
  const accountRead = async (functionName: string, args: readonly unknown[] = []) =>
    readContract(state, account, ACCOUNT_RECOVERY_ABI, functionName, args);
  const recoveryRead = async (functionName: string, args: readonly unknown[] = []) =>
    readContract(state, recoveryManager, RECOVERY_MANAGER_ABI, functionName, args);

  const inspectAccount = async () => {
    const code = state.getCode ? await state.getCode({ address: account }) : undefined;
    if (code === "0x") fail("RECOVERY_NOT_CONFIGURED", "account is not deployed");
    const [guardianRoot, guardianThreshold, configVersion, frozenUntil, validatorCount, recoveryInstalled] = await Promise.all([
      accountRead("guardianRoot"), accountRead("guardianThreshold"), accountRead("configVersion"), accountRead("frozenUntil"),
      accountRead("validatorCount"), accountRead("isModuleInstalled", [5n, recoveryManager])
    ]) as [Hex, number, bigint, bigint, bigint, boolean];
    const validators: Address[] = [];
    for (let index = 0n; index < validatorCount; index += 1n) validators.push(await accountRead("validatorAt", [index]) as Address);
    return deepFreeze({
      account, chainId, guardianRoot, guardianThreshold: Number(guardianThreshold), configVersion, frozenUntil,
      recoveryConfigured: recoveryInstalled && guardianRoot !== ZERO_BYTES32 && Number(guardianThreshold) > 0,
      validators
    });
  };

  const inspectGuardianCandidate = async (guardian: GuardianDescriptor) => {
    const verifier = address(guardian.verifier, "guardian verifier");
    if (!state.getCode) fail("INVALID_DEPLOYMENT", "guardian verifier inspection requires getCode");
    const code = await state.getCode({ address: verifier });
    if (!code || code === "0x") fail("UNSUPPORTED_GUARDIAN_VERIFIER", "guardian verifier has no runtime code", { verifier });
    const runtimeCodeHash = keccak256(code);
    if (runtimeCodeHash !== bytes32(guardian.verifierCodeHash, "guardian verifier code hash")) {
      fail("UNSUPPORTED_GUARDIAN_VERIFIER", "guardian verifier runtime code hash does not match", { verifier, runtimeCodeHash });
    }
    return deepFreeze({ supported: true, guardian: Object.freeze({ ...guardian }), keyCommitment: keyCommitmentFor(guardian), runtimeCodeHash });
  };

  const prepareGuardianConfiguration = async (input: { set: GuardianSet; delaySeconds?: number }) => {
    const current = await inspectAccount();
    const delaySeconds = input.delaySeconds ?? 259_200;
    if (!Number.isInteger(delaySeconds) || delaySeconds < 259_200 || delaySeconds > 7_776_000) fail("INVALID_DEPLOYMENT", "guardian configuration delay is outside Loom bounds");
    const inner = encodeFunctionData({ abi: ACCOUNT_RECOVERY_ABI, functionName: "setGuardianConfig", args: [input.set.root, input.set.threshold] });
    const operationId = createScheduledOperationId({ target: account, value: 0n, data: inner, configVersion: current.configVersion });
    const review: GuardianActionReview = deepFreeze({
      title: "Schedule guardian protection", action: "guardian-configuration", account, chainId,
      summary: `Schedule a ${input.set.threshold}-of-${input.set.guardians.length} guardian set after ${delaySeconds} seconds.`,
      threshold: input.set.threshold, guardianCount: input.set.guardians.length, delaySeconds,
      cancellation: "The account owner can cancel this exact scheduled operation before execution.",
      warnings: ["Recovery remains unchanged until the delay completes.", "Only the root and threshold become public on chain."]
    });
    return deepFreeze({
      kind: "guardian.configuration.prepared" as const, account, set: input.set, configVersion: current.configVersion,
      operationId, inner, delaySeconds, review,
      scheduleCall: { target: account, value: 0n, data: encodeFunctionData({ abi: ACCOUNT_RECOVERY_ABI, functionName: "scheduleCall", args: [account, 0n, inner, delaySeconds] }) },
      executeCall: { to: account, value: 0n, data: encodeFunctionData({ abi: ACCOUNT_RECOVERY_ABI, functionName: "executeScheduled", args: [account, 0n, inner] }) },
      cancelCall: { target: account, value: 0n, data: encodeFunctionData({ abi: ACCOUNT_RECOVERY_ABI, functionName: "cancelScheduled", args: [operationId] }) }
    });
  };

  const verifyApproval = async (guardian: GuardianSetMember, digest: Hex, signature: Hex) => {
    const result = await readContract(state, guardian.verifier, GUARDIAN_VERIFIER_ABI, "verify", [guardian.keyCommitment, digest, hexBytes(signature, "guardian signature", 16_384)]);
    return result === true;
  };

  return Object.freeze({
    chainId,
    account,
    recoveryManager,
    inspectAccount,
    inspectGuardianCandidate,
    prepareGuardianConfiguration,
    async prepareRecoveryValidator(input: { initData: Hex }) {
      if (!options.recoveryValidatorFactory) {
        fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "the deployment does not publish a trusted recovery validator factory");
      }
      const nonce = await recoveryRead("recoveryNonces", [account]) as bigint;
      return prepareP256RecoveryValidator({
        account,
        recoveryNonce: nonce,
        initData: input.initData,
        profile: options.recoveryValidatorFactory,
        stateTransport: state
      });
    },
    async scheduleGuardianConfiguration(prepared: Awaited<ReturnType<typeof prepareGuardianConfiguration>>) {
      return submit(account, prepared.scheduleCall.data, prepared.review, false);
    },
    async readPendingGuardianConfiguration(prepared: Awaited<ReturnType<typeof prepareGuardianConfiguration>>) {
      // `scheduledOperations` returns (readyAt, expiresAt, nonce): the slot
      // carries the execution window and an instance counter, not just a
      // readiness timestamp. `readyAt == 0` is still the "not scheduled" test.
      const [rawReadyAt, rawExpiresAt] = await accountRead("scheduledOperations", [prepared.operationId]) as
        readonly (bigint | number)[];
      const readyAt = BigInt(rawReadyAt ?? 0);
      const expiresAt = BigInt(rawExpiresAt ?? 0);
      const timestamp = state.getBlockTimestamp ? await state.getBlockTimestamp() : undefined;
      const now = timestamp === undefined ? undefined : BigInt(timestamp);
      const pending = readyAt > 0n;
      return deepFreeze({
        pending,
        operationId: prepared.operationId,
        readyAt,
        expiresAt,
        ready: now === undefined ? undefined : pending && now >= readyAt && now <= expiresAt,
        expired: now === undefined ? undefined : pending && now > expiresAt,
        chainTimestamp: now
      });
    },
    async cancelGuardianConfiguration(prepared: Awaited<ReturnType<typeof prepareGuardianConfiguration>>) {
      return submit(account, prepared.cancelCall.data, prepared.review, false);
    },
    async executeGuardianConfiguration(prepared: Awaited<ReturnType<typeof prepareGuardianConfiguration>>) {
      return submit(account, prepared.executeCall.data, prepared.review, true);
    },
    async prepareFreeze(invite: GuardianInviteV1): Promise<PreparedFreeze> {
      const accepted = validateGuardianInvite(invite, { chainId, account });
      const current = await inspectAccount();
      if (!current.recoveryConfigured) fail("RECOVERY_NOT_CONFIGURED", "account has no active guardian recovery");
      if (accepted.guardianRoot !== current.guardianRoot || BigInt(accepted.configVersion) !== current.configVersion) fail("STALE_GUARDIAN_INVITE", "guardian capability no longer matches account state");
      const [nonce, lastFreezeVersion] = await Promise.all([
        accountRead("freezeNonces", [accepted.guardian.leaf]), accountRead("lastFreezeConfigVersion", [accepted.guardian.leaf])
      ]) as [bigint, bigint];
      if (lastFreezeVersion === current.configVersion) fail("ACCOUNT_FROZEN", "this guardian already froze the current account configuration");
      return deepFreeze({
        kind: "guardian.freeze.prepared", account, guardian: accepted.guardian, proof: accepted.proof, configVersion: current.configVersion, nonce,
        digest: createFreezeDigest({ chainId, account, guardianLeaf: accepted.guardian.leaf, nonce, configVersion: current.configVersion }),
        review: {
          title: "Emergency freeze", action: "freeze", account, chainId,
          summary: "Freeze ordinary account execution for the contract-enforced emergency window.",
          cancellation: "The freeze expires by contract; the owner can clear it only after the window.",
          warnings: ["Freezing does not transfer funds or approve recovery.", "The guardian commitment and proof become public when submitted."]
        }
      });
    },
    async verifyFreezeApproval(prepared: PreparedFreeze, signature: Hex) {
      return verifyApproval(prepared.guardian, prepared.digest, signature);
    },
    async submitFreeze(prepared: PreparedFreeze, signature: Hex) {
      if (!(await verifyApproval(prepared.guardian, prepared.digest, signature))) fail("INVALID_GUARDIAN_SIGNATURE", "guardian freeze signature is invalid");
      const data = encodeFunctionData({ abi: ACCOUNT_RECOVERY_ABI, functionName: "freeze", args: [prepared.guardian.verifier, prepared.guardian.keyCommitment, prepared.guardian.salt, prepared.proof, signature] });
      return submit(account, data, prepared.review, true);
    },
    async prepareRecovery(input: { newValidator: Address; initData: Hex; newGuardianSet: GuardianSet }): Promise<PreparedRecovery> {
      const current = await inspectAccount();
      if (!current.recoveryConfigured) fail("RECOVERY_NOT_CONFIGURED", "account has no active guardian recovery");
      const [pending, nonce] = await Promise.all([
        recoveryRead("pendingRecoveries", [account]) as Promise<readonly unknown[]>,
        recoveryRead("recoveryNonces", [account]) as Promise<bigint>
      ]);
      if (BigInt(pending[5] as bigint) !== 0n) fail("RECOVERY_ALREADY_PENDING", "a recovery is already pending");
      const newValidator = address(input.newValidator, "new validator");
      if (current.validators.includes(newValidator)) fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "new recovery validator is already installed");
      if (!state.getCode) fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "validator verification requires getCode");
      const validatorCode = await state.getCode({ address: newValidator });
      if (!validatorCode || validatorCode === "0x") fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "new recovery validator has no deployed code");
      let profile = options.trustedRecoveryValidators?.find(candidate => address(candidate.address, "trusted recovery validator") === newValidator);
      if (!profile && options.recoveryValidatorFactory) {
        const provisioned = await prepareP256RecoveryValidator({
          account,
          recoveryNonce: nonce,
          initData: input.initData,
          profile: options.recoveryValidatorFactory,
          stateTransport: state
        });
        if (provisioned.validator === newValidator && provisioned.alreadyDeployed) {
          profile = {
            kind: "p256",
            address: provisioned.validator,
            runtimeCodeHash: options.recoveryValidatorFactory.validatorRuntimeCodeHash,
            allowedPolicyHooks: options.recoveryValidatorFactory.allowedPolicyHooks
          };
        }
      }
      if (!profile) fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "new recovery validator is not in the trusted deployment profile");
      const runtimeCodeHash = keccak256(validatorCode);
      if (runtimeCodeHash !== bytes32(profile.runtimeCodeHash, "trusted recovery validator code hash")) {
        fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "new recovery validator runtime code does not match the trusted deployment profile", { runtimeCodeHash });
      }
      if (input.newGuardianSet.root === current.guardianRoot) fail("STALE_GUARDIAN_INVITE", "recovery must rotate the guardian root with fresh salts");
      const oldValidators = current.validators;
      const oldValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] oldValidators"), [oldValidators]));
      const initData = hexBytes(input.initData, "validator initialization data", 65_536);
      validateP256RecoveryInitData(initData, profile);
      const initDataHash = keccak256(initData);
      const identity = {
        account, oldValidatorsHash, newValidator, initDataHash, newGuardianRoot: input.newGuardianSet.root,
        newGuardianThreshold: input.newGuardianSet.threshold, configVersion: current.configVersion, nonce
      };
      return deepFreeze({
        kind: "guardian.recovery.prepared", account, oldValidators, oldValidatorsHash, newValidator, initData, initDataHash,
        newGuardianSet: input.newGuardianSet, configVersion: current.configVersion, nonce,
        digest: createRecoveryProposalDigest({ ...identity, chainId, recoveryManager }), recoveryId: createRecoveryId(identity),
        review: {
          title: "Recover account control", action: "recovery", account, chainId,
          summary: `Replace all ${oldValidators.length} validator(s) after guardian approval and the contract delay.`,
          threshold: current.guardianThreshold, guardianCount: input.newGuardianSet.guardians.length,
          validatorChange: { from: oldValidators, to: newValidator }, delaySeconds: 259_200,
          cancellation: "The owner or the current guardian threshold can cancel before execution.",
          warnings: ["Approval helps transfer complete account control to the new credential.", "The old validators stop authorizing after execution.", "The guardian root rotates during execution."]
        }
      });
    },
    async verifyRecoveryApproval(prepared: PreparedRecovery, input: { guardian: GuardianSetMember; signature: Hex }) {
      return verifyApproval(input.guardian, prepared.digest, input.signature);
    },
    async collectRecoveryApproval(prepared: PreparedRecovery, set: GuardianSet, approvals: readonly { leaf: Hex; signature: Hex }[]) {
      return assembleGuardianApprovals({ set, approvals, threshold: set.threshold, digest: prepared.digest, verify: ({ guardian, signature }) => verifyApproval(guardian, prepared.digest, signature) });
    },
    async proposeRecovery(prepared: PreparedRecovery, approvals: readonly GuardianApprovalTuple[]) {
      if (approvals.length < prepared.review.threshold!) fail("INSUFFICIENT_APPROVALS", "guardian threshold has not been reached");
      const approvalLeaves = new Set<string>();
      const [current, pending, nonce] = await Promise.all([
        inspectAccount(),
        recoveryRead("pendingRecoveries", [account]) as Promise<readonly unknown[]>,
        recoveryRead("recoveryNonces", [account]) as Promise<bigint>
      ]);
      const currentValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] oldValidators"), [current.validators]));
      if (current.configVersion !== prepared.configVersion || nonce !== prepared.nonce || currentValidatorsHash !== prepared.oldValidatorsHash) {
        fail("RECOVERY_CONFIG_VERSION_MISMATCH", "account recovery state changed after approvals were prepared");
      }
      if (BigInt(pending[5] as bigint) !== 0n) fail("RECOVERY_ALREADY_PENDING", "a recovery became pending after approvals were prepared");
      if (current.guardianRoot === prepared.newGuardianSet.root) fail("STALE_GUARDIAN_INVITE", "recovery no longer rotates the guardian root");
      for (const approval of approvals) {
        if (approvalLeaves.has(approval.leaf)) fail("DUPLICATE_GUARDIAN", "guardian recovery approval is duplicated", { leaf: approval.leaf });
        approvalLeaves.add(approval.leaf);
        if (!state.getCode) fail("INVALID_DEPLOYMENT", "guardian verifier revalidation requires getCode");
        const code = await state.getCode({ address: approval.verifier });
        if (!code || code === "0x") fail("UNSUPPORTED_GUARDIAN_VERIFIER", "guardian verifier has no runtime code");
        const member: GuardianSetMember = {
          kind: "ecdsa",
          verifier: approval.verifier,
          verifierCodeHash: keccak256(code),
          keyCommitment: approval.keyCommitment,
          salt: approval.salt,
          leaf: approval.leaf
        };
        const liveLeaf = createGuardianLeaf(member);
        if (liveLeaf !== approval.leaf || !verifyGuardianProof({ root: current.guardianRoot, leaf: liveLeaf, proof: approval.proof })) {
          fail("GUARDIAN_PROOF_MISMATCH", "guardian approval no longer belongs to the active guardian root");
        }
        if (!(await verifyApproval(member, prepared.digest, approval.signature))) {
          fail("INVALID_GUARDIAN_SIGNATURE", "guardian recovery signature is invalid");
        }
      }
      const tuples = [...approvals].sort((left, right) => compareHex(left.leaf, right.leaf)).map(({ leaf: _leaf, ...approval }) => approval);
      const data = encodeFunctionData({ abi: RECOVERY_MANAGER_ABI, functionName: "proposeRecovery", args: [account, prepared.oldValidators, prepared.newValidator, prepared.initDataHash, prepared.newGuardianSet.root, prepared.newGuardianSet.threshold, tuples] });
      return submit(recoveryManager, data, prepared.review, true);
    },
    async readPendingRecovery() {
      const pending = await recoveryRead("pendingRecoveries", [account]) as readonly [Hex, Address, Hex, Hex, number, bigint, bigint, bigint, bigint];
      const timestamp = state.getBlockTimestamp ? await state.getBlockTimestamp() : undefined;
      const now = timestamp === undefined ? undefined : BigInt(timestamp);
      const readyAt = BigInt(pending[5]);
      const expiresAt = BigInt(pending[6]);
      const configVersion = BigInt(pending[7]);
      const nonce = BigInt(pending[8]);
      return deepFreeze({
        pending: readyAt > 0n, oldValidatorsHash: pending[0], newValidator: pending[1], initDataHash: pending[2], newGuardianRoot: pending[3],
        newGuardianThreshold: Number(pending[4]), readyAt, expiresAt, configVersion, nonce, chainTimestamp: now,
        status: readyAt === 0n ? "none" : now === undefined ? "unknown" : now < readyAt ? "delay-active" : now > expiresAt ? "expired" : "ready"
      });
    },
    async cancelRecovery(review: GuardianActionReview, approvals: readonly GuardianApprovalTuple[]) {
      const tuples = approvals.map(({ leaf: _leaf, ...approval }) => approval);
      const data = encodeFunctionData({ abi: RECOVERY_MANAGER_ABI, functionName: "cancelRecoveryWithAccountAndGuardians", args: [account, tuples] });
      return submit(recoveryManager, data, review, false);
    },
    async cancelRecoveryWithGuardians(review: GuardianActionReview, approvals: readonly GuardianApprovalTuple[]) {
      const tuples = approvals.map(({ leaf: _leaf, ...approval }) => approval);
      const data = encodeFunctionData({ abi: RECOVERY_MANAGER_ABI, functionName: "cancelRecoveryWithGuardians", args: [account, tuples] });
      return submit(recoveryManager, data, review, true);
    },
    async executeRecovery(prepared: PreparedRecovery) {
      const pending = await this.readPendingRecovery();
      if (pending.status === "delay-active") fail("RECOVERY_NOT_READY", "recovery delay has not completed");
      if (pending.status === "expired") fail("RECOVERY_EXPIRED", "recovery execution window expired");
      if (pending.status !== "ready") fail("RECOVERY_NOT_READY", "no executable recovery is pending");
      if (pending.configVersion !== prepared.configVersion) fail("RECOVERY_CONFIG_VERSION_MISMATCH", "account configuration changed since recovery approval");
      if (
        pending.oldValidatorsHash !== prepared.oldValidatorsHash
        || pending.newValidator.toLowerCase() !== prepared.newValidator.toLowerCase()
        || pending.initDataHash !== prepared.initDataHash
        || pending.newGuardianRoot !== prepared.newGuardianSet.root
        || pending.newGuardianThreshold !== prepared.newGuardianSet.threshold
        || pending.nonce !== prepared.nonce
      ) fail("RECOVERY_CONFIG_VERSION_MISMATCH", "pending recovery does not match the reviewed recovery");
      const data = encodeFunctionData({ abi: RECOVERY_MANAGER_ABI, functionName: "executeRecovery", args: [account, prepared.oldValidators, prepared.initData] });
      return submit(recoveryManager, data, prepared.review, true);
    }
  });
}

export async function assembleGuardianApprovals(input: {
  set: GuardianSet;
  approvals: readonly { leaf: Hex; signature: Hex }[];
  threshold?: number;
  verify?: (input: { guardian: GuardianSetMember; digest?: Hex; signature: Hex }) => boolean | Promise<boolean>;
  digest?: Hex;
}): Promise<{ readonly ready: boolean; readonly have: number; readonly need: number; readonly approvals: readonly GuardianApprovalTuple[] }> {
  const threshold = input.threshold ?? input.set.threshold;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > input.set.threshold) {
    fail("INVALID_THRESHOLD", "approval threshold is outside the guardian set threshold");
  }
  const seen = new Set<string>();
  const collected: GuardianApprovalTuple[] = [];
  for (const candidate of input.approvals ?? []) {
    const leaf = bytes32(candidate.leaf, "approval leaf");
    if (seen.has(leaf)) fail("DUPLICATE_GUARDIAN", "duplicate guardian approval", { leaf });
    seen.add(leaf);
    const guardian = input.set.guardians.find(item => item.leaf === leaf);
    if (!guardian) fail("GUARDIAN_PROOF_MISMATCH", "approval guardian is not in this set", { leaf });
    const signature = hexBytes(candidate.signature, "guardian signature", 16_384);
    if (input.verify && !(await input.verify({ guardian, ...(input.digest === undefined ? {} : { digest: input.digest }), signature }))) continue;
    collected.push(Object.freeze({
      verifier: guardian.verifier,
      keyCommitment: guardian.keyCommitment,
      salt: guardian.salt,
      signature,
      proof: createGuardianProof(input.set, leaf),
      leaf
    }));
  }
  collected.sort((left, right) => compareHex(left.leaf, right.leaf));
  const selected = collected.slice(0, threshold);
  return Object.freeze({ ready: selected.length >= threshold, have: collected.length, need: threshold, approvals: Object.freeze(selected) });
}

export function createFreezeDigest(input: {
  chainId: number;
  account: Address;
  guardianLeaf: Hex;
  nonce: bigint | number | string;
  configVersion: bigint | number | string;
}): Hex {
  const structHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, bytes32 guardianLeaf, uint256 nonce, uint64 configVersion"),
    [keccak256(stringToHex("Freeze(bytes32 guardianLeaf,uint256 nonce,uint64 configVersion)")), bytes32(input.guardianLeaf, "guardian leaf"), nonNegativeBigInt(input.nonce, "freeze nonce"), nonNegativeBigInt(input.configVersion, "config version")]
  ));
  return eip712Digest(eip712Domain("LoomAccount", input.chainId, input.account), structHash);
}

export interface RecoveryIdentityInput {
  readonly account: Address;
  readonly oldValidatorsHash: Hex;
  readonly newValidator: Address;
  readonly initDataHash: Hex;
  readonly newGuardianRoot: Hex;
  readonly newGuardianThreshold: number;
  readonly configVersion: bigint | number | string;
  readonly nonce: bigint | number | string;
}

export function createRecoveryProposalDigest(input: RecoveryIdentityInput & { chainId: number; recoveryManager: Address }): Hex {
  const structHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, address account, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint64 configVersion, uint64 nonce"),
    [
      keccak256(stringToHex("ProposeRecovery(address account,bytes32 oldValidatorsHash,address newValidator,bytes32 initDataHash,bytes32 newGuardianRoot,uint8 newGuardianThreshold,uint64 configVersion,uint64 nonce)")),
      address(input.account, "account"), bytes32(input.oldValidatorsHash, "old validators hash"), address(input.newValidator, "new validator"),
      bytes32(input.initDataHash, "init data hash"), bytes32(input.newGuardianRoot, "new guardian root"),
      uint8(input.newGuardianThreshold, "new guardian threshold"), nonNegativeBigInt(input.configVersion, "config version"), nonNegativeBigInt(input.nonce, "recovery nonce")
    ]
  ));
  return eip712Digest(eip712Domain("LoomRecoveryManager", input.chainId, input.recoveryManager), structHash);
}

export function createRecoveryId(input: RecoveryIdentityInput): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address account, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint64 configVersion, uint64 nonce"),
    [address(input.account, "account"), bytes32(input.oldValidatorsHash, "old validators hash"), address(input.newValidator, "new validator"), bytes32(input.initDataHash, "init data hash"), bytes32(input.newGuardianRoot, "new guardian root"), uint8(input.newGuardianThreshold, "new guardian threshold"), nonNegativeBigInt(input.configVersion, "config version"), nonNegativeBigInt(input.nonce, "recovery nonce")]
  ));
}

export function createRecoveryCancellationDigest(input: {
  chainId: number;
  recoveryManager: Address;
  account: Address;
  recoveryId: Hex;
  configVersion: bigint | number | string;
  nonce: bigint | number | string;
}): Hex {
  const structHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, address account, bytes32 recoveryId, uint64 configVersion, uint64 nonce"),
    [keccak256(stringToHex("CancelRecovery(address account,bytes32 recoveryId,uint64 configVersion,uint64 nonce)")), address(input.account, "account"), bytes32(input.recoveryId, "recovery id"), nonNegativeBigInt(input.configVersion, "config version"), nonNegativeBigInt(input.nonce, "recovery nonce")]
  ));
  return eip712Digest(eip712Domain("LoomRecoveryManager", input.chainId, input.recoveryManager), structHash);
}

export function createScheduledOperationId(input: {
  target: Address;
  value: bigint | number | string;
  data: Hex;
  configVersion: bigint | number | string;
}): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address target, uint256 value, bytes data, uint64 configVersion"),
    [address(input.target, "scheduled target"), nonNegativeBigInt(input.value, "scheduled value"), hexBytes(input.data, "scheduled calldata", 1_048_576), nonNegativeBigInt(input.configVersion, "config version")]
  ));
}

function keyCommitmentFor(guardian: GuardianDescriptor): Hex {
  if (guardian.kind === "p256") {
    return keccak256(encodeAbiParameters(
      parseAbiParameters("bytes32 x, bytes32 y"),
      [bytes32(guardian.publicKey?.x, "P-256 x coordinate"), bytes32(guardian.publicKey?.y, "P-256 y coordinate")]
    ));
  }
  const signer = guardian.kind === "ecdsa" ? guardian.address : guardian.account;
  return keccak256(encodeAbiParameters(parseAbiParameters("address signer"), [address(signer, "guardian signer")]));
}

async function readContract(
  transport: LoomStateReadTransport,
  to: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = []
): Promise<unknown> {
  try {
    const data = encodeFunctionData({ abi: abi as any, functionName: functionName as any, args: args as any });
    const result = await transport.ethCall({ to, data });
    return decodeFunctionResult({ abi: abi as any, functionName: functionName as any, data: result });
  } catch (cause) {
    throw new GuardianRecoveryError("INVALID_DEPLOYMENT", `failed to read ${functionName}`, {
      safeMessage: "Account state could not be verified.",
      details: { to, functionName },
      remediation: "Check the chain, deployment, and selected RPC, then retry.",
      cause
    });
  }
}

function eip712Domain(name: string, chainId: number, verifyingContract: Address): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, bytes32 nameHash, bytes32 versionHash, uint256 chainId, address verifyingContract"),
    [keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(stringToHex(name)), keccak256(stringToHex("1")), BigInt(positiveInteger(chainId, "chainId")), address(verifyingContract, "verifying contract")]
  ));
}

function eip712Digest(domain: Hex, structHash: Hex): Hex {
  return keccak256(concatHex(["0x1901", domain, structHash]));
}

function normalizeInviteGuardian(value: unknown): GuardianSetMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_GUARDIAN_INVITE", "invite guardian must be an object");
  const guardian = value as Record<string, unknown>;
  const allowed = ["kind", "verifier", "verifierCodeHash", "keyCommitment", "salt", "leaf"];
  if (Object.keys(guardian).some(key => !allowed.includes(key))) fail("INVALID_GUARDIAN_INVITE", "invite guardian contains unknown fields");
  if (!(["ecdsa", "p256", "erc1271"] as unknown[]).includes(guardian.kind)) fail("INVALID_GUARDIAN_INVITE", "unsupported invite guardian kind");
  const member = Object.freeze({
    kind: guardian.kind as GuardianKind,
    verifier: address(guardian.verifier, "invite guardian verifier"),
    verifierCodeHash: bytes32(guardian.verifierCodeHash, "invite verifier code hash"),
    keyCommitment: bytes32(guardian.keyCommitment, "invite key commitment"),
    salt: bytes32(guardian.salt, "invite guardian salt"),
    leaf: bytes32(guardian.leaf, "invite guardian leaf")
  });
  if (createGuardianLeaf(member) !== member.leaf) fail("GUARDIAN_PROOF_MISMATCH", "invite guardian leaf does not match its commitment");
  return member;
}

function proofArray(value: unknown): readonly Hex[] {
  if (!Array.isArray(value) || value.length > 32) fail("INVALID_GUARDIAN_INVITE", "guardian proof must contain at most 32 items");
  return Object.freeze(value.map((item, index) => bytes32(item, `guardian proof[${index}]`)));
}

function validateP256RecoveryInitData(initData: Hex, profile: P256RecoveryValidatorProfile): void {
  if (profile.kind !== "p256") fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "unsupported trusted recovery validator profile");
  if (initData.length !== 2 + 8 + (32 * 5 * 2)) {
    fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "P256 recovery initialization data must encode initialize selector plus exactly five ABI words");
  }
  let decoded: readonly [Hex, Hex, Hex, Hex, Address];
  try {
    const call = decodeFunctionData({ abi: P256ValidatorAbi, data: initData });
    if (call.functionName !== "initialize") throw new Error("unexpected P256 initializer selector");
    decoded = call.args as readonly [Hex, Hex, Hex, Hex, Address];
  } catch {
    fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "P256 recovery initialization data is not canonical initialize calldata");
  }
  if (decoded[0] === ZERO_BYTES32 || decoded[1] === ZERO_BYTES32 || decoded[2] === ZERO_BYTES32 || decoded[3] === ZERO_BYTES32) {
    fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "P256 recovery initialization data contains an empty credential binding");
  }
  const allowedHooks = profile.allowedPolicyHooks.map(hook => address(hook, "trusted recovery policy hook"));
  if (!allowedHooks.includes(address(decoded[4], "recovery policy hook"))) {
    fail("UNSUPPORTED_RECOVERED_VALIDATOR_PATH", "P256 recovery policy hook is not allowed by the trusted deployment profile");
  }
}

function randomSalt(randomBytes?: (length: number) => Uint8Array): Hex {
  if (typeof randomBytes !== "function") {
    fail("GUARDIAN_CREDENTIAL_UNAVAILABLE", "a cryptographically secure randomBytes adapter is required when guardian salts are omitted", {}, "Inject Web Crypto getRandomValues or supply explicit salts.");
  }
  const value = randomBytes(32);
  if (!(value instanceof Uint8Array) || value.length !== 32) fail("GUARDIAN_CREDENTIAL_UNAVAILABLE", "randomBytes must return exactly 32 bytes");
  return `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function hashPair(left: Hex, right: Hex): Hex {
  const a = bytes32(left, "left Merkle node");
  const b = bytes32(right, "right Merkle node");
  return keccak256(compareHex(a, b) <= 0 ? concatHex([a, b]) : concatHex([b, a]));
}

function compareHex(left: Hex, right: Hex): number {
  return left.toLowerCase().localeCompare(right.toLowerCase());
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) fail("INVALID_GUARDIAN_INVITE", `${label} must be an address`);
  return getAddress(value) as Address;
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail("INVALID_GUARDIAN_INVITE", `${label} must be bytes32`);
  return value.toLowerCase() as Hex;
}

function hexBytes(value: unknown, label: string, maxBytes: number): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail("INVALID_GUARDIAN_INVITE", `${label} must be byte-aligned hex`);
  if ((value.length - 2) / 2 > maxBytes) fail("INVALID_GUARDIAN_INVITE", `${label} exceeds ${maxBytes} bytes`);
  return value.toLowerCase() as Hex;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("INVALID_GUARDIAN_INVITE", `${label} must be a safe integer`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = integer(value, label);
  if (normalized <= 0) fail("INVALID_GUARDIAN_INVITE", `${label} must be positive`);
  return normalized;
}

function uint8(value: unknown, label: string): number {
  const normalized = integer(value, label);
  if (normalized < 1 || normalized > 255) fail("INVALID_THRESHOLD", `${label} must fit uint8 and be non-zero`);
  return normalized;
}

function nonNegativeBigInt(value: unknown, label: string): bigint {
  try {
    const normalized = BigInt(value as string | number | bigint);
    if (normalized < 0n) throw new Error();
    return normalized;
  } catch {
    fail("INVALID_GUARDIAN_INVITE", `${label} must be a non-negative integer`);
  }
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    fail("INVALID_GUARDIAN_INVITE", `${label} must be between 1 and ${maxLength} characters`);
  }
  return value.trim();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(typeof value === "bigint" ? value.toString() : value);
}

function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fail(code: GuardianRecoveryErrorCode, message: string, details: Record<string, unknown> = {}, remediation?: string): never {
  throw new GuardianRecoveryError(code, message, { details, ...(remediation === undefined ? {} : { remediation }) });
}
