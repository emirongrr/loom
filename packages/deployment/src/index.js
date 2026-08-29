// @loom/deployment — the Loom wallet deployment toolkit.
//
// One reusable path from "forge script --broadcast" to an application that can
// trust its configuration: parse the broadcast, read live bytecode from the
// chain, compute code hashes locally, write a versioned manifest plus env
// values, then re-read everything and verify env == manifest == chain. Every
// mismatch fails closed. Node-only tooling — never import this from an app's
// runtime bundle.

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import jsSha3 from "js-sha3";
import { manifestHash, parseDeploymentManifest } from "@loom/core";

const { keccak256 } = jsSha3;

/** Versioned manifest schema; bump on breaking manifest shape changes. */
export const MANIFEST_SCHEMA_VERSION = 1;
/** Browser-wallet trust profile schema. Version 2 requires the account handle registry. */
export const WALLET_PROFILE_SCHEMA_VERSION = 2;

export const DEFAULT_CONTRACTS = Object.freeze({
  accountFactory: "LoomAccountFactory",
  passkeyValidator: "P256Validator",
  recoveryValidatorFactory: "P256RecoveryValidatorFactory",
  accountImplementation: "LoomAccount"
});

export const NATIVE_P256_PRECOMPILE = "0x0000000000000000000000000000000000000100";

/** Normalize the application operator's opt-in onboarding policy. */
export function buildWalletOnboardingPolicy(options = { activation: "counterfactual" }) {
  assertObject(options, "onboarding");
  if (options.activation === "counterfactual") {
    if (options.sponsorship !== undefined) throw new Error("counterfactual onboarding cannot carry sponsorship policy");
    return Object.freeze({ activation: "counterfactual" });
  }
  if (options.activation !== "sponsored") throw new Error("onboarding activation must be counterfactual or sponsored");
  const sponsorship = assertObject(options.sponsorship, "onboarding.sponsorship");
  if (typeof sponsorship.policyId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(sponsorship.policyId)) {
    throw new Error("sponsorship policyId is invalid");
  }
  const decimal = (value, label) => {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/u.test(value)) throw new Error(`${label} is invalid`);
    return value;
  };
  const bounded = (value, maximum, label) => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${label} is invalid`);
    return value;
  };
  if (sponsorship.privateSubmission !== true) throw new Error("sponsored onboarding requires privateSubmission=true");
  if (sponsorship.publicFallback !== "disabled" && sponsorship.publicFallback !== "explicit-rejection") {
    throw new Error("sponsorship publicFallback is invalid");
  }
  return Object.freeze({
    activation: "sponsored",
    sponsorship: Object.freeze({
      policyId: sponsorship.policyId,
      policyHash: `0x${keccak256(Buffer.from(sponsorship.policyId, "utf8"))}`,
      maxCostWei: decimal(sponsorship.maxCostWei, "sponsorship maxCostWei"),
      maxFactoryDataBytes: bounded(sponsorship.maxFactoryDataBytes, 65_536, "sponsorship maxFactoryDataBytes"),
      maxActivationsPerPrincipal: bounded(sponsorship.maxActivationsPerPrincipal, 1_000, "sponsorship maxActivationsPerPrincipal"),
      windowSeconds: bounded(sponsorship.windowSeconds, 31_536_000, "sponsorship windowSeconds"),
      privateSubmission: true,
      publicFallback: sponsorship.publicFallback
    })
  });
}

/** Build a live-chain-verified profile for a standalone recovery provisioner. */
export async function buildP256RecoveryValidatorProvisioner(options) {
  assertObject(options, "options");
  const rpc = requireFunction(options.rpc, "options.rpc");
  const factory = requireAddress(options.factory, "factory");
  const validator = requireAddress(options.validator, "validator");
  const [runtimeCodeHash, validatorRuntimeCodeHash, fallbackVerifier, validatorFallbackVerifier] = await Promise.all([
    codehash(rpc, factory, "P256RecoveryValidatorFactory"),
    codehash(rpc, validator, "P256Validator"),
    readAddressView(rpc, factory, "fallbackVerifier()", "factory fallback verifier"),
    readAddressView(rpc, validator, "fallbackVerifier()", "validator fallback verifier")
  ]);
  if (fallbackVerifier.toLowerCase() !== validatorFallbackVerifier.toLowerCase()) {
    throw new Error("recovery factory fallback verifier does not match the sampled recovery validator child");
  }
  return Object.freeze({ address: factory, runtimeCodeHash, validatorRuntimeCodeHash, fallbackVerifier });
}

export function parseFoundryBroadcast(broadcast, options = {}) {
  assertObject(broadcast, "broadcast");
  const contracts = { ...DEFAULT_CONTRACTS, ...(options.contracts ?? {}) };
  const created = new Map();

  const transactionHashes = new Map();
  for (const tx of broadcast.transactions ?? []) {
    if (tx?.transactionType === "CREATE" && tx.contractName && tx.contractAddress) {
      created.set(tx.contractName, requireAddress(tx.contractAddress, `CREATE ${tx.contractName}`));
      if (typeof tx.hash === "string") transactionHashes.set(tx.contractName, tx.hash);
    }
    for (const contract of tx?.additionalContracts ?? []) {
      if (contract.contractName && contract.address) {
        created.set(contract.contractName, requireAddress(contract.address, `additional ${contract.contractName}`));
        if (typeof tx?.hash === "string") transactionHashes.set(contract.contractName, tx.hash);
      }
    }
  }

  const addressFor = label => {
    const contractName = contracts[label];
    const address = created.get(contractName);
    if (!address) throw new Error(`broadcast has no deployed ${contractName}`);
    return address;
  };

  return Object.freeze({
    chainId: Number(broadcast.chain),
    sourceCommit: typeof broadcast.commit === "string" ? broadcast.commit : undefined,
    addresses: Object.freeze({
      accountFactory: addressFor("accountFactory"),
      passkeyValidator: addressFor("passkeyValidator"),
      recoveryValidatorFactory: addressFor("recoveryValidatorFactory"),
      accountImplementation: addressFor("accountImplementation")
    }),
    createdContracts: Object.freeze(Object.fromEntries(created)),
    transactionHashes: Object.freeze(Object.fromEntries(transactionHashes))
  });
}

export async function buildWalletDeploymentManifest(options) {
  assertObject(options, "options");
  const parsed = parseFoundryBroadcast(options.broadcast, options);
  const rpc = requireFunction(options.rpc, "options.rpc");
  const entryPoint = requireAddress(options.entryPoint, "entryPoint");
  const p256VerifierMode = options.p256VerifierMode ?? "native-precompile";
  if (p256VerifierMode !== "native-precompile" && p256VerifierMode !== "fallback-contract") {
    throw new Error("p256VerifierMode must be native-precompile or fallback-contract");
  }
  const p256Verifier = requireAddress(
    options.p256Verifier ?? (p256VerifierMode === "native-precompile" ? NATIVE_P256_PRECOMPILE : undefined),
    "p256Verifier"
  );
  // No fallback. `P256RecoveryValidator` is a different contract from
  // `P256Validator` -- it carries the reservation storage and a closed
  // initializer, and its runtime code is 409 bytes longer -- so sampling the
  // passkey validator here pinned a hash that no deployed recovery child can
  // ever match. Consumers verifying a child against it would reject a perfectly
  // good one, which fails closed and is therefore quiet: a recovery that stops
  // working for a reason nobody is told. The caller knows which child it means.
  const recoveryValidator = requireAddress(options.recoveryValidator, "recoveryValidator");

  const codehashes = {
    accountFactory: await codehash(rpc, parsed.addresses.accountFactory, "LoomAccountFactory"),
    passkeyValidator: await codehash(rpc, parsed.addresses.passkeyValidator, "P256Validator"),
    recoveryValidatorFactory: await codehash(rpc, parsed.addresses.recoveryValidatorFactory, "P256RecoveryValidatorFactory"),
    accountImplementation: await codehash(rpc, parsed.addresses.accountImplementation, "LoomAccount")
  };
  const recoveryValidatorRuntimeCodeHash = await codehash(rpc, recoveryValidator, "P256 recovery validator child");
  await codehash(rpc, entryPoint, "EntryPoint");
  if (p256VerifierMode === "fallback-contract") {
    codehashes.p256Verifier = await codehash(rpc, p256Verifier, "P-256 fallback verifier");
  }

  if (p256VerifierMode === "native-precompile") {
    const probe = await requireFunction(options.probeP256, "options.probeP256")();
    if (!probe?.supported) throw new Error("native P-256 precompile probe failed");
  }

  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    chainId: parsed.chainId,
    deployedAt: options.deployedAt ?? new Date().toISOString(),
    sourceCommit: parsed.sourceCommit ?? null,
    entryPoint,
    accountFactory: parsed.addresses.accountFactory,
    passkeyValidator: parsed.addresses.passkeyValidator,
    recoveryValidatorFactory: parsed.addresses.recoveryValidatorFactory,
    recoveryValidatorProvisioner: Object.freeze({
      address: parsed.addresses.recoveryValidatorFactory,
      runtimeCodeHash: codehashes.recoveryValidatorFactory,
      validatorRuntimeCodeHash: recoveryValidatorRuntimeCodeHash,
      fallbackVerifier: p256VerifierMode === "native-precompile"
        ? "0x0000000000000000000000000000000000000000"
        : p256Verifier
    }),
    p256Verifier,
    p256VerifierMode,
    codehashes: Object.freeze(codehashes),
    deploymentBlock: options.deploymentBlock ?? null,
    notes: options.notes ?? "Generated by Loom deployment tooling."
  });
}

/**
 * Build the canonical `LoomDeploymentManifest` (the single schema in
 * `@loom/core`) from a parsed broadcast and live chain code. Every code hash is
 * read from the chain, never trusted from the broadcast; the result is schema-
 * validated before it is returned.
 */
/**
 * Contract name -> field, for the browser wallet's deployment profile.
 *
 * A superset of `DEFAULT_CONTRACTS`: that manifest describes what a passkey
 * wallet needs to create and operate an account, while this one also names the
 * contracts the recovery and guardian surfaces read. Naming a contract here
 * commits the wallet to verifying its code on every operation, so the list is
 * exactly what the app uses and nothing more.
 */
export const WALLET_PROFILE_CONTRACTS = Object.freeze({
  factory: "LoomAccountFactory",
  appRegistry: "AppAccountRegistry",
  implementation: "LoomAccount",
  validator: "P256Validator",
  policyHook: "PolicyHook",
  recoveryModule: "RecoveryManager",
  recoveryIntentBoard: "RecoveryIntentBoard"
});

const WALLET_PROFILE_GUARDIAN_VERIFIERS = Object.freeze({
  ecdsa: "ECDSAGuardianVerifier",
  p256: "P256GuardianVerifier",
  erc1271: "ERC1271GuardianVerifier"
});

/**
 * Build the browser wallet's deployment profile from a Foundry broadcast.
 *
 * The profile is the only thing that wallet trusts: it names the contracts and
 * pins their runtime code hashes, and the app refuses to sign anything when the
 * chain disagrees with it. Deriving it from the broadcast and the chain is what
 * keeps it from drifting away from the deployment it claims to describe.
 *
 * `recoveryIntentBoard` and the guardian verifiers are optional (ADR-0024): a
 * deployment may omit them, and the wallet simply has no on-chain discovery.
 * Every contract that *is* named must have code, which `codehash` enforces.
 */
/**
 * The runtime code hash a recovery validator child will actually carry.
 *
 * Hashing the compiler artifact's `deployedBytecode` directly is wrong, and
 * wrong in a way that fails closed and looks like something else: the child
 * declares immutables, Solidity leaves them as zeroed placeholders in the
 * artifact, and fills them in at construction. So the artifact's hash can never
 * equal any deployed child's, and a manifest pinned to it makes every recovery
 * on that deployment unusable -- the wallet reports "deployed recovery
 * validator code does not match the trusted deployment profile" and stops,
 * correctly, on a manifest error.
 *
 * The placeholders are filled here from values the deployment already knows,
 * resolved by variable name through the artifact's AST rather than by the
 * order the ids happen to appear in. An immutable with no supplied value is an
 * error: guessing one would produce a hash that pins nothing.
 *
 * `baseArtifacts` carries the contracts the child inherits from. Solidity keeps
 * each source unit's AST in its own artifact, so an immutable declared in a
 * base -- `fallbackVerifier` is -- cannot be named from the child's AST alone,
 * and an id that stays unresolved is refused rather than skipped.
 */
export function recoveryValidatorRuntimeCodeHash(options) {
  const artifact = options?.artifact;
  const deployed = artifact?.deployedBytecode;
  const object = deployed?.object;
  if (typeof object !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(object)) {
    throw new Error("recovery validator artifact has no deployed bytecode");
  }
  const references = deployed.immutableReferences ?? {};
  const names = new Map();
  for (const source of [artifact, ...(options?.baseArtifacts ?? [])]) {
    for (const [id, name] of immutableNamesFromAst(source?.ast)) names.set(id, name);
  }
  const bytes = Buffer.from(object.slice(2), "hex");

  for (const [id, slots] of Object.entries(references)) {
    const name = names.get(String(id));
    if (!name) throw new Error(`recovery validator artifact does not name immutable ${id}`);
    const value = options?.values?.[name];
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error(`no address supplied for recovery validator immutable "${name}"`);
    }
    const word = Buffer.alloc(32);
    Buffer.from(value.slice(2), "hex").copy(word, 12);
    for (const slot of slots) {
      if (slot.length !== 32) throw new Error(`recovery validator immutable "${name}" is not one word`);
      word.copy(bytes, slot.start);
    }
  }
  return `0x${keccak256(bytes)}`;
}

function immutableNamesFromAst(ast) {
  const names = new Map();
  const walk = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable" && node.name) {
      names.set(String(node.id), node.name);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(ast);
  return names;
}

export async function buildWalletProfileManifest(options) {
  assertObject(options, "options");
  const parsed = parseFoundryBroadcast(options.broadcast, options);
  const rpc = requireFunction(options.rpc, "options.rpc");
  const entryPoint = requireAddress(options.entryPoint, "entryPoint");
  const proxyCreationCode = options.proxyCreationCode;
  if (typeof proxyCreationCode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(proxyCreationCode)) {
    throw new Error("proxyCreationCode must be the LoomAccountProxy creation bytecode");
  }

  const created = parsed.createdContracts;
  const profile = { schemaVersion: WALLET_PROFILE_SCHEMA_VERSION, chainId: parsed.chainId, entryPoint, proxyCreationCode };
  if (options.onboarding !== undefined) profile.onboarding = buildWalletOnboardingPolicy(options.onboarding);
  const runtimeCodeHashes = { entryPoint: await codehash(rpc, entryPoint, "EntryPoint") };

  for (const [field, contractName] of Object.entries(WALLET_PROFILE_CONTRACTS)) {
    const address = created[contractName];
    if (!address) {
      if (field === "recoveryIntentBoard" || field === "recoveryModule") continue;
      throw new Error(`broadcast has no deployed ${contractName}`);
    }
    profile[field] = address;
    runtimeCodeHashes[field] = await codehash(rpc, address, contractName);
  }

  const onboardingPaymaster = created.OnboardingPaymaster;
  if (options.onboarding?.activation === "sponsored" && !onboardingPaymaster) {
    throw new Error("sponsored onboarding requires a deployed OnboardingPaymaster");
  }
  if (onboardingPaymaster) {
    profile.onboardingPaymaster = onboardingPaymaster;
    runtimeCodeHashes.onboardingPaymaster = await codehash(rpc, onboardingPaymaster, "OnboardingPaymaster");
  }

  // A code hash proves what each contract is, but not that the addresses belong
  // to the same deployment. Pin the immutable graph as well. In particular,
  // wallet discovery executes registry code through the factory, so accepting
  // an unbound or unpinned registry would turn a locator into an unreviewed
  // dependency even though it still grants no account authority.
  const bindings = await Promise.all([
    readAddressView(rpc, profile.factory, "entryPoint()", "factory EntryPoint"),
    readAddressView(rpc, profile.factory, "accountImplementation()", "factory implementation"),
    readAddressView(rpc, profile.factory, "registry()", "factory registry"),
    readAddressView(rpc, profile.appRegistry, "factory()", "registry factory")
  ]);
  const expectedBindings = [entryPoint, profile.implementation, profile.appRegistry, profile.factory];
  for (let index = 0; index < bindings.length; index += 1) {
    if (bindings[index].toLowerCase() !== expectedBindings[index].toLowerCase()) {
      throw new Error("deployed factory, implementation, EntryPoint, and registry are not one immutable deployment");
    }
  }

  const guardianVerifiers = {};
  for (const [field, contractName] of Object.entries(WALLET_PROFILE_GUARDIAN_VERIFIERS)) {
    const address = created[contractName];
    if (!address) continue;
    guardianVerifiers[field] = address;
    runtimeCodeHashes[`${field === "ecdsa" ? "ecdsa" : field}GuardianVerifier`] =
      await codehash(rpc, address, contractName);
  }
  if (Object.keys(guardianVerifiers).length > 0) profile.guardianVerifiers = guardianVerifiers;

  profile.runtimeCodeHashes = runtimeCodeHashes;

  const provisionerAddress = created[DEFAULT_CONTRACTS.recoveryValidatorFactory];
  if (provisionerAddress) {
    // `buildP256RecoveryValidatorProvisioner` samples a deployed child to learn
    // its runtime hash. A fresh deployment has none, so the hash comes from the
    // build the factory was compiled against. That is checkable rather than
    // assumed: the factory's `validatorInitCodeHash()` is derived from the same
    // creation code, so comparing it to the local artifact proves the factory
    // will produce exactly this child.
    const validatorRuntimeCodeHash = requireBytes32(
      options.validatorRuntimeCodeHash,
      "options.validatorRuntimeCodeHash"
    );
    profile.recoveryValidatorProvisioner = Object.freeze({
      address: provisionerAddress,
      runtimeCodeHash: await codehash(rpc, provisionerAddress, "P256RecoveryValidatorFactory"),
      validatorRuntimeCodeHash,
      fallbackVerifier: await readAddressView(
        rpc, provisionerAddress, "fallbackVerifier()", "recovery factory fallback verifier"
      )
    });
  }

  return Object.freeze(profile);
}

export async function buildCanonicalDeploymentManifest(options) {
  assertObject(options, "options");
  const parsed = options.parsed ?? parseFoundryBroadcast(options.broadcast, options);
  const rpc = requireFunction(options.rpc, "options.rpc");
  const entryPoint = requireAddress(options.entryPoint, "entryPoint");
  const releaseChannel = options.releaseChannel ?? "devnet";
  const compatibility = assertObject(options.compatibility, "options.compatibility");
  const proxyArtifact = assertObject(options.proxyArtifact, "options.proxyArtifact");
  const proxyCreation = proxyArtifact.bytecode?.object;
  const proxyRuntime = proxyArtifact.deployedBytecode?.object;
  if (typeof proxyCreation !== "string" || typeof proxyRuntime !== "string") {
    throw new Error("options.proxyArtifact must carry bytecode.object and deployedBytecode.object");
  }
  const recoveryValidator = requireAddress(
    options.recoveryValidator ?? parsed.addresses.passkeyValidator,
    "recoveryValidator"
  );

  const manifest = parseDeploymentManifest({
    schemaVersion: "1",
    releaseChannel,
    chainId: parsed.chainId,
    entryPoint: {
      address: entryPoint,
      runtimeCodeHash: await codehash(rpc, entryPoint, "EntryPoint")
    },
    factory: {
      address: parsed.addresses.accountFactory,
      runtimeCodeHash: await codehash(rpc, parsed.addresses.accountFactory, "LoomAccountFactory")
    },
    account: {
      implementation: {
        address: parsed.addresses.accountImplementation,
        runtimeCodeHash: await codehash(rpc, parsed.addresses.accountImplementation, "LoomAccount")
      },
      proxy: {
        creationCodeHash: `0x${keccak256(Buffer.from(proxyCreation.slice(2), "hex"))}`,
        runtimeCodeHash: `0x${keccak256(Buffer.from(proxyRuntime.slice(2), "hex"))}`
      }
    },
    modules: [
      {
        type: "validator",
        address: parsed.addresses.passkeyValidator,
        runtimeCodeHash: await codehash(rpc, parsed.addresses.passkeyValidator, "P256Validator"),
        version: requireString(compatibility.contractRelease, "compatibility.contractRelease"),
        status: options.moduleStatus ?? "beta"
      },
      ...(options.extraModules ?? [])
    ],
    provisioners: [
      {
        type: "p256-recovery-validator-factory",
        address: parsed.addresses.recoveryValidatorFactory,
        runtimeCodeHash: await codehash(rpc, parsed.addresses.recoveryValidatorFactory, "P256RecoveryValidatorFactory"),
        validatorRuntimeCodeHash: await codehash(rpc, recoveryValidator, "P256 recovery validator child"),
        fallbackVerifier: requireAddress(
          options.p256FallbackVerifier ?? (options.p256VerifierMode === "fallback-contract" ? options.p256Verifier : "0x0000000000000000000000000000000000000000"),
          "p256FallbackVerifier"
        )
      }
    ],
    compatibility: {
      contractRelease: compatibility.contractRelease,
      sdkRange: requireString(compatibility.sdkRange, "compatibility.sdkRange")
    }
  });
  return Object.freeze({ manifest, manifestHash: manifestHash(manifest) });
}

/**
 * The canonical manifest's live-chain verification (`verifyOnChain`): re-read
 * every address's runtime code and compare its keccak256 with the manifest.
 * A single mismatch fails the report — a wallet must refuse the address set.
 */
export async function verifyManifestOnChain(options) {
  assertObject(options, "options");
  const rpc = requireFunction(options.rpc, "options.rpc");
  const manifest = parseDeploymentManifest(options.manifest);
  const checks = [];
  const check = async (label, address, expected) => {
    const code = await rpc("eth_getCode", [address, "latest"]);
    const actual = typeof code === "string" && code !== "0x" ? `0x${keccak256(Buffer.from(code.slice(2), "hex"))}` : null;
    checks.push(Object.freeze({ label, address, ok: actual !== null && actual.toLowerCase() === expected.toLowerCase() }));
  };

  await check("entryPoint", manifest.entryPoint.address, manifest.entryPoint.runtimeCodeHash);
  await check("factory", manifest.factory.address, manifest.factory.runtimeCodeHash);
  await check(
    "account.implementation",
    manifest.account.implementation.address,
    manifest.account.implementation.runtimeCodeHash
  );
  for (const [index, module] of manifest.modules.entries()) {
    await check(`modules[${index}] (${module.type})`, module.address, module.runtimeCodeHash);
  }
  for (const [index, provisioner] of (manifest.provisioners ?? []).entries()) {
    await check(`provisioners[${index}] (${provisioner.type})`, provisioner.address, provisioner.runtimeCodeHash);
  }

  const failures = checks.filter(entry => !entry.ok);
  return Object.freeze({
    ok: failures.length === 0,
    manifestHash: manifestHash(manifest),
    checks: Object.freeze(checks),
    failures: Object.freeze(failures)
  });
}

/**
 * Bind an application (wallet) manifest to the canonical manifest it was
 * projected from: the shared facts must agree, and the returned record carries
 * `sourceManifestHash` so the app record can never drift from the release
 * evidence unnoticed (one schema, projections only).
 */
export function bindWalletManifestToCanonical(appManifest, canonicalManifest) {
  assertObject(appManifest, "appManifest");
  const canonical = parseDeploymentManifest(canonicalManifest);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const disagreements = [];
  if (appManifest.chainId !== canonical.chainId) disagreements.push("chainId");
  if (!same(appManifest.entryPoint, canonical.entryPoint.address)) disagreements.push("entryPoint");
  if (!same(appManifest.accountFactory, canonical.factory.address)) disagreements.push("accountFactory");
  const validator = canonical.modules.find(module => module.type === "validator");
  if (!validator || !same(appManifest.passkeyValidator, validator.address)) disagreements.push("passkeyValidator");
  const recoveryFactory = canonical.provisioners?.find(item => item.type === "p256-recovery-validator-factory");
  if (!recoveryFactory || !same(appManifest.recoveryValidatorFactory, recoveryFactory.address)) {
    disagreements.push("recoveryValidatorFactory");
  }
  const appProvisioner = appManifest.recoveryValidatorProvisioner;
  if (!appProvisioner || typeof appProvisioner !== "object" || Array.isArray(appProvisioner)) {
    disagreements.push("recoveryValidatorProvisioner");
  } else if (recoveryFactory) {
    for (const field of ["address", "runtimeCodeHash", "validatorRuntimeCodeHash", "fallbackVerifier"]) {
      if (!same(appProvisioner[field], recoveryFactory[field])) {
        disagreements.push(`recoveryValidatorProvisioner.${field}`);
      }
    }
  }
  if (disagreements.length !== 0) {
    throw new Error(`app manifest disagrees with the canonical manifest: ${disagreements.join(", ")}`);
  }
  return Object.freeze({ ...appManifest, sourceManifestHash: manifestHash(canonical) });
}

export function envForWalletDeployment(manifest, manifestReference) {
  assertObject(manifest, "manifest");
  return Object.freeze({
    EXPO_PUBLIC_LOOM_CHAIN_ID: String(requirePositiveInteger(manifest.chainId, "manifest.chainId")),
    EXPO_PUBLIC_LOOM_L1_CHAIN_ID: String(manifest.chainId),
    EXPO_PUBLIC_LOOM_ENTRYPOINT: requireAddress(manifest.entryPoint, "manifest.entryPoint"),
    EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY: requireAddress(manifest.accountFactory, "manifest.accountFactory"),
    EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR: requireAddress(manifest.passkeyValidator, "manifest.passkeyValidator"),
    EXPO_PUBLIC_LOOM_RECOVERY_VALIDATOR_FACTORY: requireAddress(manifest.recoveryValidatorFactory, "manifest.recoveryValidatorFactory"),
    EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE: requireMode(manifest.p256VerifierMode),
    EXPO_PUBLIC_LOOM_P256_VERIFIER: requireAddress(manifest.p256Verifier, "manifest.p256Verifier"),
    EXPO_PUBLIC_LOOM_DEPLOYMENT_MANIFEST: requireString(manifestReference, "manifestReference")
  });
}

export async function writeWalletDeploymentFiles(options) {
  assertObject(options, "options");
  const manifest = assertObject(options.manifest, "options.manifest");
  const manifestPath = requireString(options.manifestPath, "options.manifestPath");
  const envPath = requireString(options.envPath, "options.envPath");
  const manifestReference = requireString(options.manifestReference, "options.manifestReference");
  const envUpdates = envForWalletDeployment(manifest, manifestReference);

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const envText = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  await writeFile(envPath, updateEnv(envText, envUpdates));
  return Object.freeze({ manifestPath, envPath, envUpdates });
}

export async function verifyWalletDeploymentFiles(options) {
  assertObject(options, "options");
  const manifest = JSON.parse(await readFile(requireString(options.manifestPath, "options.manifestPath"), "utf8"));
  const env = parseEnv(await readFile(requireString(options.envPath, "options.envPath"), "utf8"));
  const rpc = requireFunction(options.rpc, "options.rpc");
  const checks = [];
  const add = (label, ok, detail = "") => checks.push(Object.freeze({ label, ok, detail }));
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  add("env chainId == manifest chainId", same(env.EXPO_PUBLIC_LOOM_CHAIN_ID, manifest.chainId));
  add("env l1ChainId == manifest chainId", same(env.EXPO_PUBLIC_LOOM_L1_CHAIN_ID, manifest.chainId));
  add("env entryPoint == manifest", same(env.EXPO_PUBLIC_LOOM_ENTRYPOINT, manifest.entryPoint));
  add("env factory == manifest", same(env.EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY, manifest.accountFactory));
  add("env passkeyValidator == manifest", same(env.EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR, manifest.passkeyValidator));
  add("env recoveryValidatorFactory == manifest", same(env.EXPO_PUBLIC_LOOM_RECOVERY_VALIDATOR_FACTORY, manifest.recoveryValidatorFactory));
  add("env p256Verifier == manifest", same(env.EXPO_PUBLIC_LOOM_P256_VERIFIER, manifest.p256Verifier));
  add("env p256 mode == manifest", same(env.EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE, manifest.p256VerifierMode));

  const provisioner = assertObject(manifest.recoveryValidatorProvisioner, "manifest.recoveryValidatorProvisioner");
  add("recovery provisioner address == manifest", same(provisioner.address, manifest.recoveryValidatorFactory));
  add("recovery provisioner factory hash == manifest", same(provisioner.runtimeCodeHash, manifest.codehashes?.recoveryValidatorFactory));
  const liveProvisioner = await buildP256RecoveryValidatorProvisioner({
    rpc,
    factory: provisioner.address,
    validator: options.recoveryValidator ?? manifest.passkeyValidator
  });
  add(
    "recovery provisioner validator hash == chain",
    same(provisioner.validatorRuntimeCodeHash, liveProvisioner.validatorRuntimeCodeHash),
    options.recoveryValidator ?? manifest.passkeyValidator
  );
  add("recovery provisioner fallback verifier == chain", same(provisioner.fallbackVerifier, liveProvisioner.fallbackVerifier));

  const codeAddress = {
    accountFactory: manifest.accountFactory,
    passkeyValidator: manifest.passkeyValidator,
    recoveryValidatorFactory: manifest.recoveryValidatorFactory,
    accountImplementation: options.accountImplementation,
    p256Verifier: manifest.p256Verifier
  };
  for (const [name, expected] of Object.entries(manifest.codehashes ?? {})) {
    const address = requireAddress(codeAddress[name], `address for ${name}`);
    const fresh = await codehash(rpc, address, name);
    add(`chain codehash(${name}) == manifest`, same(fresh, expected), address);
  }

  if (manifest.p256VerifierMode === "native-precompile") {
    const probe = await requireFunction(options.probeP256, "options.probeP256")();
    add("native P-256 precompile verifies a live test vector", probe?.supported === true, manifest.p256Verifier);
  }

  const failures = checks.filter(check => !check.ok);
  return Object.freeze({ manifest: Object.freeze(manifest), env: Object.freeze(env), checks: Object.freeze(checks), failures });
}

export async function connectWalletAppDeployment(options) {
  const broadcastPath = requireString(options.broadcastPath, "options.broadcastPath");
  const broadcast = JSON.parse(await readFile(broadcastPath, "utf8"));
  const parsed = parseFoundryBroadcast(broadcast, options);
  const manifest = await buildWalletDeploymentManifest({
    ...options,
    broadcast,
    notes:
      options.notes ??
      `Generated by Loom deployment tooling from ${relative(dirname(options.manifestPath), broadcastPath)}`
  });
  await writeWalletDeploymentFiles({ ...options, manifest });
  const verification = await verifyWalletDeploymentFiles({
    ...options,
    accountImplementation: parsed.addresses.accountImplementation
  });
  if (verification.failures.length !== 0) {
    throw new Error(`${verification.failures.length} deployment verification check(s) failed`);
  }
  return Object.freeze({ manifest, verification, parsed });
}

export function createJsonRpcClient(rpcUrl) {
  requireString(rpcUrl, "rpcUrl");
  return async function rpc(method, params) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

function updateEnv(source, updates) {
  let env = source;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    env = new RegExp(`^${key}=`, "m").test(env)
      ? env.replace(new RegExp(`^${key}=.*$`, "m"), line)
      : `${env.trimEnd()}\n${line}\n`;
  }
  return env;
}

function parseEnv(source) {
  return Object.freeze(Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter(line => line.includes("=") && !line.trim().startsWith("#"))
      .map(line => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()])
  ));
}

async function codehash(rpc, address, label) {
  const code = await rpc("eth_getCode", [requireAddress(address, label), "latest"]);
  if (!code || code === "0x") throw new Error(`${label} at ${address} has no code on chain`);
  if (!/^0x[0-9a-fA-F]*$/u.test(code)) throw new Error(`${label} returned non-hex code`);
  return `0x${keccak256(Buffer.from(code.slice(2), "hex"))}`;
}

function requireBytes32(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${label} must be a 32-byte hash`);
  }
  return value.toLowerCase();
}

function requireMode(value) {
  if (value !== "native-precompile" && value !== "fallback-contract") {
    throw new Error("p256VerifierMode must be native-precompile or fallback-contract");
  }
  return value;
}

function requireAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`${label} must be a 20-byte address`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireString(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required`);
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new Error(`${label} is required`);
  return value;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

async function readAddressView(rpc, contract, signature, label) {
  const selector = `0x${keccak256(signature).slice(0, 8)}`;
  const result = await rpc("eth_call", [{ to: contract, data: selector }, "latest"]);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error(`${label} returned malformed data`);
  }
  return requireAddress(`0x${result.slice(-40)}`, label);
}

// ---------------------------------------------------------------------------
// Native P-256 precompile probe (EIP-7951).
//
// Signs a fresh P-256 vector with a throwaway software key and asks the
// precompile at 0x100 to verify it via eth_call. A functioning precompile
// returns 32-byte 0x…01 for the valid signature and empty output for a
// corrupted one; anything else means native mode must not be used.
// ---------------------------------------------------------------------------

export async function probeP256Precompile(rpc) {
  const call = requireFunction(rpc, "rpc");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const message = crypto.randomBytes(64);
  const hash = crypto.createHash("sha256").update(message).digest();
  const derSig = crypto.sign("sha256", message, { key: privateKey, dsaEncoding: "der" });
  const jwk = publicKey.export({ format: "jwk" });
  const input =
    "0x" +
    Buffer.concat([
      hash,
      derSignatureToRs(derSig),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url")
    ]).toString("hex");

  const valid = await call("eth_call", [{ to: NATIVE_P256_PRECOMPILE, data: input }, "latest"]);
  const corrupted = input.slice(0, 2 + 64) + (input[2 + 64] === "a" ? "b" : "a") + input.slice(2 + 65);
  const invalid = await call("eth_call", [{ to: NATIVE_P256_PRECOMPILE, data: corrupted }, "latest"]);

  return Object.freeze({
    supported:
      valid === "0x0000000000000000000000000000000000000000000000000000000000000001" &&
      (invalid === "0x" || invalid === null),
    valid,
    invalid
  });
}

function derSignatureToRs(der) {
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  i += 1;
  const rLength = der[i];
  i += 1;
  const r = der.slice(i, i + rLength);
  i += rLength;
  i += 1;
  const sLength = der[i];
  i += 1;
  const s = der.slice(i, i + sLength);
  const pad = bytes => {
    let b = Buffer.from(bytes);
    while (b.length > 32) b = b.slice(1);
    while (b.length < 32) b = Buffer.concat([Buffer.alloc(1), b]);
    return b;
  };
  return Buffer.concat([pad(r), pad(s)]);
}

// ---------------------------------------------------------------------------
// Foundry deployment runner.
//
// Spawns `forge script <script> --rpc-url <url> --broadcast` with the given
// environment and resolves with the broadcast path. The runner never parses
// forge's stdout — the broadcast JSON is the machine-readable source of truth.
// ---------------------------------------------------------------------------

export async function runFoundryDeployment(options) {
  assertObject(options, "options");
  const repoRoot = requireString(options.repoRoot, "options.repoRoot");
  const script = requireString(options.script, "options.script");
  const rpcUrl = requireString(options.rpcUrl, "options.rpcUrl");
  const scriptFile = script.includes(":") ? script.slice(0, script.indexOf(":")) : script;
  // Foundry names the broadcast directory after the script file as given,
  // extension included, so the file name is used as it stands.
  const scriptName = scriptFile.split("/").pop();

  const forgeBin =
    options.forgeBin ??
    [join(repoRoot, "node_modules", "@foundry-rs", "forge-win32-amd64", "bin", "forge.exe")].find(existsSync) ??
    "forge";
  const spawnImpl = options.spawn ?? spawn;

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawnImpl(forgeBin, ["script", script, "--rpc-url", rpcUrl, "--broadcast", ...(options.extraArgs ?? [])], {
      cwd: repoRoot,
      stdio: options.stdio ?? "inherit",
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.on("error", reject);
    child.on("exit", code => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`forge deployment exited with code ${exitCode}; nothing was connected`);
  }

  const chainId = requirePositiveInteger(options.chainId, "options.chainId");
  const broadcastPath = join(repoRoot, "broadcast", scriptName, String(chainId), "run-latest.json");
  if (!existsSync(broadcastPath)) {
    throw new Error(`forge reported success but the broadcast is missing: ${broadcastPath}`);
  }
  return Object.freeze({ broadcastPath, forgeBin });
}

// ---------------------------------------------------------------------------
// Per-network deployment records (deployments/<chainId>.json).
//
// The registry pattern used across the ecosystem (hardhat-deploy, Ignition's
// deployed_addresses.json): one JSON file per network mapping contract names
// to addresses plus provenance, so other tooling can consume a deployment
// without re-parsing forge broadcasts.
// ---------------------------------------------------------------------------

export async function saveDeploymentRecord(options) {
  assertObject(options, "options");
  const directory = requireString(options.directory, "options.directory");
  const manifest = assertObject(options.manifest, "options.manifest");
  const parsed = assertObject(options.parsed, "options.parsed");
  const record = Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    chainId: requirePositiveInteger(manifest.chainId, "manifest.chainId"),
    deployedAt: manifest.deployedAt ?? null,
    sourceCommit: manifest.sourceCommit ?? null,
    contracts: parsed.createdContracts,
    transactionHashes: parsed.transactionHashes ?? {},
    manifest
  });
  await mkdir(directory, { recursive: true });
  const recordPath = join(directory, `${record.chainId}.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return Object.freeze({ recordPath, record });
}

export async function loadDeploymentRecord(options) {
  assertObject(options, "options");
  const recordPath = join(
    requireString(options.directory, "options.directory"),
    `${requirePositiveInteger(options.chainId, "options.chainId")}.json`
  );
  if (!existsSync(recordPath)) return undefined;
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `deployment record ${recordPath} uses schema ${record.schemaVersion}; this toolkit expects ${MANIFEST_SCHEMA_VERSION}`
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Full pipeline: deploy -> connect -> verify -> record.
// ---------------------------------------------------------------------------

export async function deployAndConnectWallet(options) {
  assertObject(options, "options");
  const rpc = options.rpc ?? createJsonRpcClient(requireString(options.rpcUrl, "options.rpcUrl"));
  const probeP256 = options.probeP256 ?? (() => probeP256Precompile(rpc));

  const { broadcastPath } = await runFoundryDeployment(options);
  const connected = await connectWalletAppDeployment({
    ...options,
    broadcastPath,
    rpc,
    probeP256
  });
  let recordPath;
  if (options.recordDirectory) {
    ({ recordPath } = await saveDeploymentRecord({
      directory: options.recordDirectory,
      manifest: connected.manifest,
      parsed: connected.parsed
    }));
  }
  return Object.freeze({ ...connected, broadcastPath, recordPath });
}

// ---------------------------------------------------------------------------
// Deployment gas report.
//
// Extracts the real gas each contract deployment cost from a Foundry
// broadcast: every CREATE transaction matched to its receipt by transaction
// hash, so ordering assumptions cannot silently misattribute gas. gasUsed is
// the computational cost and is identical for the same bytecode on any chain,
// so a devnet run reports the same per-contract deployment gas as mainnet.
// ---------------------------------------------------------------------------

export function deploymentGasReport(broadcast, options = {}) {
  assertObject(broadcast, "broadcast");
  const exclude = new Set(options.exclude ?? []);
  const gasByHash = new Map();
  for (const receipt of broadcast.receipts ?? []) {
    if (receipt?.transactionHash && receipt.gasUsed) {
      gasByHash.set(receipt.transactionHash.toLowerCase(), BigInt(receipt.gasUsed));
    }
  }

  const contracts = [];
  let totalGas = 0n;
  for (const tx of broadcast.transactions ?? []) {
    if (tx?.transactionType !== "CREATE" || !tx.contractName || exclude.has(tx.contractName)) continue;
    const gas = tx.hash ? gasByHash.get(tx.hash.toLowerCase()) : undefined;
    if (gas === undefined) continue;
    totalGas += gas;
    contracts.push(
      Object.freeze({ contractName: tx.contractName, address: tx.contractAddress ?? null, gasUsed: Number(gas) })
    );
  }
  return Object.freeze({ contracts: Object.freeze(contracts), totalGas: Number(totalGas) });
}
