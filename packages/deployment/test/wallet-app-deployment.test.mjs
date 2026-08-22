import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jsSha3 from "js-sha3";
import {
  bindWalletManifestToCanonical,
  buildCanonicalDeploymentManifest,
  buildP256RecoveryValidatorProvisioner,
  buildWalletDeploymentManifest,
  buildWalletProfileManifest,
  connectWalletAppDeployment,
  envForWalletDeployment,
  parseFoundryBroadcast,
  verifyManifestOnChain,
  verifyWalletDeploymentFiles
, recoveryValidatorRuntimeCodeHash } from "../src/index.js";

const { keccak256 } = jsSha3;
const ENTRYPOINT = address("entrypoint");
const FACTORY = address("factory");
const P256 = address("p256");
const RECOVERY_CHILD = address("p256-recovery-child");
const RECOVERY_FACTORY = address("p256-recovery-factory");
const ACCOUNT = address("account");

test("builds a standalone recovery provisioner profile from live code and immutables", async () => {
  const zeroWord = `0x${"0".repeat(64)}`;
  const rpc = async (method, params) => {
    if (method === "eth_getCode") return rpcFor()(method, params);
    assert.equal(method, "eth_call");
    assert.equal(params[0].data, `0x${keccak256("fallbackVerifier()").slice(0, 8)}`);
    return zeroWord;
  };
  const profile = await buildP256RecoveryValidatorProvisioner({ rpc, factory: RECOVERY_FACTORY, validator: RECOVERY_CHILD });
  assert.deepEqual(profile, {
    address: RECOVERY_FACTORY,
    runtimeCodeHash: codehash("recovery-factory-code"),
    validatorRuntimeCodeHash: codehash("p256-recovery-child-code"),
    fallbackVerifier: "0x0000000000000000000000000000000000000000"
  });
});

test("parses a Foundry broadcast into wallet deployment components", () => {
  const parsed = parseFoundryBroadcast(broadcast());
  assert.equal(parsed.chainId, 11155111);
  assert.deepEqual(parsed.addresses, {
    accountFactory: FACTORY,
    passkeyValidator: P256,
    recoveryValidatorFactory: RECOVERY_FACTORY,
    accountImplementation: ACCOUNT
  });
});

test("builds a manifest from chain code, not from broadcast trust", async () => {
  const manifest = await buildWalletDeploymentManifest({
    broadcast: broadcast(),
    rpc: rpcFor(),
    entryPoint: ENTRYPOINT,
    recoveryValidator: RECOVERY_CHILD,
    probeP256: async () => ({ supported: true })
  });

  assert.equal(manifest.accountFactory, FACTORY);
  assert.equal(manifest.p256VerifierMode, "native-precompile");
  assert.equal(manifest.codehashes.accountFactory, codehash("factory-code"));
  assert.equal(manifest.codehashes.passkeyValidator, codehash("p256-code"));
  assert.equal(manifest.recoveryValidatorFactory, RECOVERY_FACTORY);
  assert.deepEqual(manifest.recoveryValidatorProvisioner, {
    address: RECOVERY_FACTORY,
    runtimeCodeHash: codehash("recovery-factory-code"),
    validatorRuntimeCodeHash: codehash("p256-recovery-child-code"),
    fallbackVerifier: "0x0000000000000000000000000000000000000000"
  });
  assert.equal(manifest.codehashes.recoveryValidatorFactory, codehash("recovery-factory-code"));
  assert.equal(manifest.codehashes.accountImplementation, codehash("account-code"));
});

test("writes env-compatible values and verifies env manifest chain agreement", async () => {
  const root = await fixtureRoot();
  await connectWalletAppDeployment({
    broadcastPath: join(root, "broadcast.json"),
    manifestPath: join(root, "deployment", "sepolia.manifest.json"),
    envPath: join(root, ".env.local"),
    manifestReference: "deployment/sepolia.manifest.json",
    rpc: rpcFor(),
    entryPoint: ENTRYPOINT,
    recoveryValidator: RECOVERY_CHILD,
    probeP256: async () => ({ supported: true })
  });

  const verification = await verifyWalletDeploymentFiles({
    manifestPath: join(root, "deployment", "sepolia.manifest.json"),
    envPath: join(root, ".env.local"),
    rpc: rpcFor(),
    recoveryValidator: RECOVERY_CHILD,
    accountImplementation: ACCOUNT,
    probeP256: async () => ({ supported: true })
  });
  assert.equal(verification.failures.length, 0);
  assert.equal(verification.env.EXPO_PUBLIC_LOOM_DEPLOYMENT_MANIFEST, "deployment/sepolia.manifest.json");
});

test("reports changed app values instead of silently accepting drift", async () => {
  const manifest = {
    chainId: 11155111,
    entryPoint: ENTRYPOINT,
    accountFactory: FACTORY,
    passkeyValidator: P256,
    recoveryValidatorFactory: RECOVERY_FACTORY,
    recoveryValidatorProvisioner: {
      address: RECOVERY_FACTORY,
      runtimeCodeHash: codehash("recovery-factory-code"),
      validatorRuntimeCodeHash: codehash("p256-code"),
      fallbackVerifier: "0x0000000000000000000000000000000000000000"
    },
    p256Verifier: address("native"),
    p256VerifierMode: "native-precompile",
    codehashes: {
      accountFactory: codehash("factory-code"),
      passkeyValidator: codehash("p256-code"),
      recoveryValidatorFactory: codehash("recovery-factory-code"),
      accountImplementation: codehash("account-code")
    }
  };
  assert.equal(envForWalletDeployment(manifest, "deployment/sepolia.manifest.json").EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY, FACTORY);

  const root = await fixtureRoot();
  await writeFile(join(root, "deployment", "sepolia.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, ".env.local"), [
    "EXPO_PUBLIC_LOOM_CHAIN_ID=11155111",
    "EXPO_PUBLIC_LOOM_L1_CHAIN_ID=11155111",
    `EXPO_PUBLIC_LOOM_ENTRYPOINT=${ENTRYPOINT}`,
    `EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY=${address("wrong-factory")}`,
    `EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR=${P256}`,
    `EXPO_PUBLIC_LOOM_RECOVERY_VALIDATOR_FACTORY=${RECOVERY_FACTORY}`,
    "EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE=native-precompile",
    `EXPO_PUBLIC_LOOM_P256_VERIFIER=${address("native")}`,
    "EXPO_PUBLIC_LOOM_DEPLOYMENT_MANIFEST=deployment/sepolia.manifest.json",
    ""
  ].join("\n"));

  const verification = await verifyWalletDeploymentFiles({
    manifestPath: join(root, "deployment", "sepolia.manifest.json"),
    envPath: join(root, ".env.local"),
    rpc: rpcFor(),
    accountImplementation: ACCOUNT,
    probeP256: async () => ({ supported: true })
  });
  assert.match(verification.failures.map(item => item.label).join("\n"), /env factory == manifest/);
});

test("rejects missing broadcast components and missing chain code", async () => {
  const missing = broadcast().transactions.filter(tx => tx.contractName !== "P256Validator");
  assert.throws(() => parseFoundryBroadcast({ chain: 11155111, transactions: missing }), /P256Validator/);
  const missingRecoveryFactory = broadcast().transactions.filter(tx => tx.contractName !== "P256RecoveryValidatorFactory");
  assert.throws(
    () => parseFoundryBroadcast({ chain: 11155111, transactions: missingRecoveryFactory }),
    /P256RecoveryValidatorFactory/
  );

  await assert.rejects(
    () => buildWalletDeploymentManifest({
      broadcast: broadcast(),
      rpc: async () => "0x",
      entryPoint: ENTRYPOINT,
      recoveryValidator: RECOVERY_CHILD,
      probeP256: async () => ({ supported: true })
    }),
    /has no code on chain/
  );
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "loom-wallet-deployment-"));
  await mkdir(join(root, "deployment"), { recursive: true });
  await writeFile(join(root, "broadcast.json"), `${JSON.stringify(broadcast(), null, 2)}\n`);
  await writeFile(join(root, ".env.local"), "EXPO_PUBLIC_LOOM_RPC_URL=\n");
  return root;
}

function rpcFor() {
  const codes = new Map([
    [ENTRYPOINT.toLowerCase(), "entrypoint-code"],
    [FACTORY.toLowerCase(), "factory-code"],
    [P256.toLowerCase(), "p256-code"],
    [RECOVERY_CHILD.toLowerCase(), "p256-recovery-child-code"],
    [RECOVERY_FACTORY.toLowerCase(), "recovery-factory-code"],
    [ACCOUNT.toLowerCase(), "account-code"]
  ]);
  return async (method, params) => {
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    assert.equal(method, "eth_getCode");
    return hexText(codes.get(String(params[0]).toLowerCase()) ?? "");
  };
}

function broadcast() {
  return {
    chain: 11155111,
    commit: "0123456789abcdef",
    transactions: [
      { transactionType: "CREATE", contractName: "LoomAccountFactory", contractAddress: FACTORY },
      { transactionType: "CREATE", contractName: "P256Validator", contractAddress: P256 },
      { transactionType: "CREATE", contractName: "P256RecoveryValidatorFactory", contractAddress: RECOVERY_FACTORY },
      { transactionType: "CREATE", contractName: "LoomAccount", contractAddress: ACCOUNT }
    ]
  };
}

function codehash(text) {
  return `0x${keccak256(Buffer.from(hexText(text).slice(2), "hex"))}`;
}

function hexText(text) {
  return `0x${Buffer.from(text, "utf8").toString("hex")}`;
}

function address(seed) {
  return `0x${keccak256(seed).slice(0, 40)}`;
}

function proxyArtifact() {
  return { bytecode: { object: hexText("proxy-creation") }, deployedBytecode: { object: hexText("proxy-runtime") } };
}

async function canonicalFixture() {
  const { manifest } = await buildCanonicalDeploymentManifest({
    broadcast: broadcast(),
    rpc: rpcFor(),
    entryPoint: ENTRYPOINT,
    recoveryValidator: RECOVERY_CHILD,
    releaseChannel: "testnet",
    compatibility: { contractRelease: "0.1.0", sdkRange: "^0.1.0" },
    proxyArtifact: proxyArtifact()
  });
  return manifest;
}

test("builds a schema-valid canonical manifest from live chain code", async () => {
  const manifest = await canonicalFixture();
  assert.equal(manifest.schemaVersion, "1");
  assert.equal(manifest.chainId, 11155111);
  assert.equal(manifest.entryPoint.runtimeCodeHash, codehash("entrypoint-code"));
  assert.equal(manifest.factory.runtimeCodeHash, codehash("factory-code"));
  assert.equal(manifest.account.implementation.runtimeCodeHash, codehash("account-code"));
  assert.equal(manifest.account.proxy.creationCodeHash, codehash("proxy-creation"));
  assert.equal(manifest.modules[0].type, "validator");
  assert.equal(manifest.modules[0].runtimeCodeHash, codehash("p256-code"));
  assert.equal(manifest.provisioners[0].validatorRuntimeCodeHash, codehash("p256-recovery-child-code"));
});

test("verifyManifestOnChain passes on agreement and fails closed on drift", async () => {
  const manifest = await canonicalFixture();

  const clean = await verifyManifestOnChain({ rpc: rpcFor(), manifest });
  assert.equal(clean.ok, true);
  assert.equal(clean.failures.length, 0);
  assert.match(clean.manifestHash, /^0x[0-9a-f]{64}$/);

  // The same chain with the factory's code swapped out must fail exactly there.
  const drifted = async (method, params) => {
    assert.equal(method, "eth_getCode");
    if (String(params[0]).toLowerCase() === FACTORY.toLowerCase()) return hexText("tampered-code");
    return rpcFor()(method, params);
  };
  const report = await verifyManifestOnChain({ rpc: drifted, manifest });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map(entry => entry.label), ["factory"]);
});

test("app manifests bind to the canonical manifest and reject disagreement", async () => {
  const canonical = await canonicalFixture();
  const app = await buildWalletDeploymentManifest({
    broadcast: broadcast(),
    rpc: rpcFor(),
    entryPoint: ENTRYPOINT,
    recoveryValidator: RECOVERY_CHILD,
    probeP256: async () => ({ supported: true })
  });

  const bound = bindWalletManifestToCanonical(app, canonical);
  assert.match(bound.sourceManifestHash, /^0x[0-9a-f]{64}$/);
  assert.equal(bound.accountFactory, app.accountFactory);

  const foreign = { ...app, passkeyValidator: address("other-validator") };
  assert.throws(() => bindWalletManifestToCanonical(foreign, canonical), /passkeyValidator/);

  const forgedProvisioner = {
    ...app,
    recoveryValidatorProvisioner: {
      ...app.recoveryValidatorProvisioner,
      validatorRuntimeCodeHash: codehash("forged-recovery-child")
    }
  };
  assert.throws(
    () => bindWalletManifestToCanonical(forgedProvisioner, canonical),
    /recoveryValidatorProvisioner\.validatorRuntimeCodeHash/
  );
});

test("p256 probe accepts only a 1-for-valid, empty-for-corrupted precompile", async () => {
  const { probeP256Precompile } = await import("../src/index.js");
  const ONE = `0x${"0".repeat(63)}1`;

  let calls = 0;
  const healthy = await probeP256Precompile(async (method, params) => {
    assert.equal(method, "eth_call");
    assert.equal(params[0].to, "0x0000000000000000000000000000000000000100");
    // First call carries the valid vector, second the corrupted one.
    return calls++ === 0 ? ONE : "0x";
  });
  assert.equal(healthy.supported, true);

  const alwaysOne = await probeP256Precompile(async () => ONE);
  assert.equal(alwaysOne.supported, false, "a precompile that accepts corrupted signatures must be rejected");

  const dead = await probeP256Precompile(async () => "0x");
  assert.equal(dead.supported, false, "an absent precompile must be rejected");
});

test("deployment records round-trip per network and reject unknown schemas", async () => {
  const { saveDeploymentRecord, loadDeploymentRecord, MANIFEST_SCHEMA_VERSION } = await import("../src/index.js");
  const directory = await mkdtemp(join(tmpdir(), "loom-deploy-record-"));
  const manifest = { chainId: 11155111, deployedAt: "2026-07-10T00:00:00.000Z", sourceCommit: "abc" };
  const parsed = {
    createdContracts: { LoomAccountFactory: FACTORY },
    transactionHashes: { LoomAccountFactory: "0x1234" }
  };

  const { recordPath, record } = await saveDeploymentRecord({ directory, manifest, parsed });
  assert.match(recordPath, /11155111\.json$/);
  assert.equal(record.schemaVersion, MANIFEST_SCHEMA_VERSION);

  const loaded = await loadDeploymentRecord({ directory, chainId: 11155111 });
  assert.equal(loaded.contracts.LoomAccountFactory, FACTORY);
  assert.equal(loaded.transactionHashes.LoomAccountFactory, "0x1234");
  assert.equal(await loadDeploymentRecord({ directory, chainId: 1 }), undefined);

  await writeFile(join(directory, "5.json"), JSON.stringify({ schemaVersion: 999 }));
  await assert.rejects(loadDeploymentRecord({ directory, chainId: 5 }), /schema 999/);
});

test("foundry runner fails closed on non-zero exit and missing broadcast", async () => {
  const { runFoundryDeployment } = await import("../src/index.js");
  const fakeSpawn = exitCode => () => ({
    on(event, handler) {
      if (event === "exit") setImmediate(() => handler(exitCode));
    }
  });

  await assert.rejects(
    runFoundryDeployment({
      repoRoot: tmpdir(),
      script: "script/DeploySepolia.s.sol:DeploySepolia",
      rpcUrl: "https://rpc.example",
      chainId: 11155111,
      forgeBin: "forge",
      spawn: fakeSpawn(1)
    }),
    /exited with code 1/
  );

  await assert.rejects(
    runFoundryDeployment({
      repoRoot: tmpdir(),
      script: "script/DeploySepolia.s.sol:DeploySepolia",
      rpcUrl: "https://rpc.example",
      chainId: 11155111,
      forgeBin: "forge",
      spawn: fakeSpawn(0)
    }),
    /broadcast is missing/
  );
});

test("deployment gas report attributes CREATE gas by transaction hash", async () => {
  const { deploymentGasReport } = await import("../src/index.js");
  const broadcast = {
    transactions: [
      { transactionType: "CREATE", contractName: "Factory", contractAddress: FACTORY, hash: "0xAA" },
      { transactionType: "CALL", contractName: "Factory", hash: "0xBB" },
      { transactionType: "CREATE", contractName: "Helper", contractAddress: ACCOUNT, hash: "0xCC" }
    ],
    // Deliberately out of order to prove hash-matching, not index-matching.
    receipts: [
      { transactionHash: "0xcc", gasUsed: "0x2710" },
      { transactionHash: "0xaa", gasUsed: "0x3e8" },
      { transactionHash: "0xbb", gasUsed: "0xffff" }
    ]
  };

  const all = deploymentGasReport(broadcast);
  assert.deepEqual(all.contracts.map(c => [c.contractName, c.gasUsed]), [["Factory", 1000], ["Helper", 10000]]);
  assert.equal(all.totalGas, 11000, "only CREATE gas is summed");

  const excluded = deploymentGasReport(broadcast, { exclude: ["Helper"] });
  assert.deepEqual(excluded.contracts.map(c => c.contractName), ["Factory"]);
  assert.equal(excluded.totalGas, 1000);
});

// `P256RecoveryValidator` is not `P256Validator`: it adds reservation storage
// and a closed initializer, so its runtime code differs. Defaulting to the
// passkey validator pinned a hash no deployed child can match, and a consumer
// checking a child against it would reject a good one -- quietly, because
// failing closed looks like caution rather than a bug.
test("the recovery child address must be given, never guessed from the passkey validator", async () => {
  await assert.rejects(
    buildWalletDeploymentManifest({
      broadcast: broadcast(),
      rpc: rpcFor(),
      entryPoint: ENTRYPOINT,
      p256VerifierMode: "native-precompile",
      probeP256: async () => ({ supported: true })
    }),
    /recoveryValidator/u
  );
});

test("a supplied recovery child is what gets pinned", async () => {
  const manifest = await buildWalletDeploymentManifest({
    broadcast: broadcast(),
    rpc: rpcFor(),
    entryPoint: ENTRYPOINT,
    recoveryValidator: RECOVERY_CHILD,
    p256VerifierMode: "native-precompile",
    probeP256: async () => ({ supported: true })
  });
  assert.equal(
    manifest.recoveryValidatorProvisioner.validatorRuntimeCodeHash,
    `0x${keccak256(Buffer.from("p256-recovery-child-code"))}`,
    "the child's own code hash, not the passkey validator's"
  );
});

// --- Browser wallet profile ------------------------------------------------
//
// The profile is the only thing the browser wallet trusts, and it names more
// contracts than the mobile manifest: the recovery and guardian surfaces read
// them too. These cover what must be in it, what may be absent, and what must
// never be claimed without code behind it.

const POLICY_HOOK = address("policy-hook");
const RECOVERY_MANAGER = address("recovery-manager");
const INTENT_BOARD = address("recovery-intent-board");
const ECDSA_GUARDIAN = address("ecdsa-guardian-verifier");
const CHILD_RUNTIME_HASH = `0x${keccak256("child-runtime")}`;

function profileBroadcast(over = []) {
  return {
    chain: 11155111,
    transactions: [
      { transactionType: "CREATE", contractName: "LoomAccountFactory", contractAddress: FACTORY },
      { transactionType: "CREATE", contractName: "LoomAccount", contractAddress: ACCOUNT },
      { transactionType: "CREATE", contractName: "P256Validator", contractAddress: P256 },
      { transactionType: "CREATE", contractName: "PolicyHook", contractAddress: POLICY_HOOK },
      { transactionType: "CREATE", contractName: "RecoveryManager", contractAddress: RECOVERY_MANAGER },
      { transactionType: "CREATE", contractName: "RecoveryIntentBoard", contractAddress: INTENT_BOARD },
      { transactionType: "CREATE", contractName: "ECDSAGuardianVerifier", contractAddress: ECDSA_GUARDIAN },
      { transactionType: "CREATE", contractName: "P256RecoveryValidatorFactory", contractAddress: RECOVERY_FACTORY },
      ...over
    ]
  };
}

function profileRpc(extraCodes = {}) {
  const codes = new Map([
    [ENTRYPOINT.toLowerCase(), "entrypoint-code"],
    [FACTORY.toLowerCase(), "factory-code"],
    [ACCOUNT.toLowerCase(), "account-code"],
    [P256.toLowerCase(), "p256-code"],
    [POLICY_HOOK.toLowerCase(), "policy-hook-code"],
    [RECOVERY_MANAGER.toLowerCase(), "recovery-manager-code"],
    [INTENT_BOARD.toLowerCase(), "intent-board-code"],
    [ECDSA_GUARDIAN.toLowerCase(), "ecdsa-guardian-code"],
    [RECOVERY_FACTORY.toLowerCase(), "recovery-factory-code"],
    ...Object.entries(extraCodes)
  ]);
  return async (method, params) => {
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    assert.equal(method, "eth_getCode");
    return hexText(codes.get(String(params[0]).toLowerCase()) ?? "");
  };
}

const profileOptions = (over = {}) => ({
  broadcast: profileBroadcast(),
  rpc: profileRpc(),
  entryPoint: ENTRYPOINT,
  proxyCreationCode: hexText("proxy-creation"),
  validatorRuntimeCodeHash: CHILD_RUNTIME_HASH,
  ...over
});

test("the wallet profile names every contract the browser wallet reads, with hashes from the chain", async () => {
  const profile = await buildWalletProfileManifest(profileOptions());

  assert.equal(profile.chainId, 11155111);
  assert.equal(profile.factory, FACTORY);
  assert.equal(profile.implementation, ACCOUNT);
  assert.equal(profile.validator, P256);
  assert.equal(profile.policyHook, POLICY_HOOK);
  assert.equal(profile.recoveryModule, RECOVERY_MANAGER);
  assert.equal(profile.recoveryIntentBoard, INTENT_BOARD);
  assert.equal(profile.guardianVerifiers.ecdsa, ECDSA_GUARDIAN);
  assert.equal(profile.runtimeCodeHashes.policyHook, `0x${keccak256(Buffer.from("policy-hook-code"))}`);
  assert.equal(profile.runtimeCodeHashes.recoveryIntentBoard, `0x${keccak256(Buffer.from("intent-board-code"))}`);
  assert.equal(profile.recoveryValidatorProvisioner.validatorRuntimeCodeHash, CHILD_RUNTIME_HASH);
});

// ADR-0024: the board is optional. A deployment without it is valid, and the
// wallet simply has no on-chain discovery.
test("a deployment without the board still produces a profile", async () => {
  const withoutBoard = profileBroadcast();
  withoutBoard.transactions = withoutBoard.transactions.filter(t => t.contractName !== "RecoveryIntentBoard");
  const profile = await buildWalletProfileManifest(profileOptions({ broadcast: withoutBoard }));
  assert.equal(profile.recoveryIntentBoard, undefined);
  assert.equal(profile.runtimeCodeHashes.recoveryIntentBoard, undefined);
});

test("a broadcast missing a contract the wallet must have is refused", async () => {
  const withoutValidator = profileBroadcast();
  withoutValidator.transactions = withoutValidator.transactions.filter(t => t.contractName !== "P256Validator");
  await assert.rejects(
    buildWalletProfileManifest(profileOptions({ broadcast: withoutValidator })),
    /no deployed P256Validator/u
  );
});

// A profile naming an address with no code can never pass the wallet's runtime
// verification, so producing one is the failure.
test("a named contract with no code on chain is refused", async () => {
  const rpc = async (method, params) => {
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    return String(params[0]).toLowerCase() === INTENT_BOARD.toLowerCase() ? "0x" : hexText("code");
  };
  await assert.rejects(buildWalletProfileManifest(profileOptions({ rpc })), /has no code on chain/u);
});

test("the proxy creation code must be real bytecode", async () => {
  await assert.rejects(
    buildWalletProfileManifest(profileOptions({ proxyCreationCode: "not-hex" })),
    /proxyCreationCode/u
  );
});

// The child's hash cannot be sampled from a fresh deployment, so it is supplied
// -- and must be a hash, not whatever the caller happened to have.
test("the recovery child runtime hash must be a 32-byte hash", async () => {
  await assert.rejects(
    buildWalletProfileManifest(profileOptions({ validatorRuntimeCodeHash: "0x1234" })),
    /must be a 32-byte hash/u
  );
});

// A child that declares immutables cannot be pinned by hashing the compiler's
// `deployedBytecode`: Solidity zeroes the placeholders there and fills them at
// construction. The wallet shipped a Sepolia profile pinned to the artifact
// hash, so every recovery on that deployment failed closed with "deployed
// recovery validator code does not match the trusted deployment profile" --
// a manifest error that read to the user as a lost passkey.
const IMMUTABLE_ARTIFACT = Object.freeze({
  ast: {
    nodeType: "SourceUnit",
    nodes: [{ nodeType: "VariableDeclaration", mutability: "immutable", id: 11, name: "recoveryValidatorFactory" }]
  },
  deployedBytecode: {
    object: `0x${"00".repeat(96)}`,
    immutableReferences: { 11: [{ start: 32, length: 32 }] }
  }
});

test("the recovery validator hash fills immutables instead of hashing placeholders", () => {
  const filled = recoveryValidatorRuntimeCodeHash({
    artifact: IMMUTABLE_ARTIFACT,
    values: { recoveryValidatorFactory: "0x02e1d96947bbc6e5b3c94f6ab1753da7a8b0b48f" }
  });
  const placeholders = recoveryValidatorRuntimeCodeHash({
    artifact: {
      ...IMMUTABLE_ARTIFACT,
      deployedBytecode: { object: IMMUTABLE_ARTIFACT.deployedBytecode.object, immutableReferences: {} }
    },
    values: {}
  });
  assert.notEqual(filled, placeholders, "an unfilled artifact must not pass for a deployed child");
  assert.match(filled, /^0x[0-9a-f]{64}$/);
});

test("an immutable with no supplied value is refused rather than guessed", () => {
  assert.throws(
    () => recoveryValidatorRuntimeCodeHash({ artifact: IMMUTABLE_ARTIFACT, values: {} }),
    /recoveryValidatorFactory/
  );
});

// An id declared in a base contract lives in that contract's own artifact. Left
// unresolved it would silently keep its zero placeholder, which is exactly the
// bug being fixed, so it fails instead.
test("an immutable the artifacts cannot name is refused, not skipped", () => {
  assert.throws(
    () => recoveryValidatorRuntimeCodeHash({
      artifact: { ast: { nodeType: "SourceUnit", nodes: [] }, deployedBytecode: IMMUTABLE_ARTIFACT.deployedBytecode },
      values: { recoveryValidatorFactory: "0x02e1d96947bbc6e5b3c94f6ab1753da7a8b0b48f" }
    }),
    /does not name immutable 11/
  );
});

test("a base contract's immutable is resolved through baseArtifacts", () => {
  const hash = recoveryValidatorRuntimeCodeHash({
    artifact: { ast: { nodeType: "SourceUnit", nodes: [] }, deployedBytecode: IMMUTABLE_ARTIFACT.deployedBytecode },
    baseArtifacts: [IMMUTABLE_ARTIFACT],
    values: { recoveryValidatorFactory: "0x02e1d96947bbc6e5b3c94f6ab1753da7a8b0b48f" }
  });
  assert.match(hash, /^0x[0-9a-f]{64}$/);
});
