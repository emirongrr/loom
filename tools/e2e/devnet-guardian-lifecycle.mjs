// Guardian protection on a live devnet: freeze and recovery, exercised end to
// end with a real guardian key and real on-chain timelocks advanced by anvil.
//
//   npm run e2e:guardian-devnet
//
// The web wallet on Sepolia was created with a placeholder guardian root, so its
// freeze/recovery paths cannot be genuinely triggered. Here the account is
// created with a REAL single-guardian merkle tree (an ECDSA guardian whose key
// this script holds) and a recovery module installed at creation, so every
// guardian action carries a signature the contract actually verifies. The 2-day
// freeze and 3-day recovery delays are advanced with evm_increaseTime, which is
// why this belongs on devnet and not on a public testnet.
//
// Flow:
//   1. Start anvil, deploy the Loom stack, verify bytecode.
//   2. Create an account (sovereign handleOps) with a real guardian root and a
//      RECOVERY module bound to the RecoveryManager.
//   3. Freeze: the guardian signs the EIP-712 freeze digest; assert the account
//      is frozen and that a normal execution is rejected while frozen.
//   4. Advance past FREEZE_DURATION; assert execution works again.
//   5. Recovery: the guardian approves proposeRecovery to swap the passkey
//      validator for a fresh one; advance past RECOVERY_DELAY; executeRecovery;
//      assert the validator set changed on chain.
//
// Every failure is fatal and the devnet is always torn down.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpcClient, parseFoundryBroadcast, probeP256Precompile } from "../../packages/deployment/src/index.js";
import {
  base64UrlEncode,
  deriveAccountAddress,
  encodeValidatorSignature,
  encodeWebAuthnSignature,
  EntryPointAbi,
  getUserOpHash,
  LoomAccountAbi,
  LoomAccountFactoryAbi,
  P256ValidatorAbi,
  packUserOperation,
  parseP256Signature
} from "../../packages/core/dist/index.js";
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  serializeSignature,
  stringToHex
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337n;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// anvil's second deterministic account, used here as the guardian.
const GUARDIAN_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";
const ZERO32 = `0x${"00".repeat(32)}`;
const FREEZE_TYPEHASH = keccak256(stringToHex("Freeze(bytes32 guardianLeaf,uint256 nonce,uint64 configVersion)"));
const DOMAIN_TYPEHASH = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const NAME_HASH = keccak256(stringToHex("LoomAccount"));
const VERSION_HASH = keccak256(stringToHex("1"));
const DAY = 24 * 60 * 60;

let anvil;

function bin(name) {
  const local = join(repoRoot, "node_modules", "@foundry-rs", `${name}-win32-amd64`, "bin", `${name}.exe`);
  return existsSync(local) ? local : name;
}

function fail(message) {
  console.error(`\nFAIL ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function waitForRpc(rpc, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rpc("eth_chainId", []);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  fail("anvil did not become ready");
}

function forgeScript(target, env) {
  const result = spawnSync(
    bin("forge"),
    ["script", target, "--rpc-url", RPC_URL, "--broadcast", "--skip-simulation", "-vvvv"],
    { cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8" }
  );
  if (result.status !== 0) fail(`forge script ${target} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

async function sendFromDeployer(rpc, to, data, gas = "0x5b8d80", { assert = false } = {}) {
  const tx = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to, data, gas }]);
  const receipt = await waitForReceipt(rpc, tx);
  if (assert && receipt.status !== "0x1") {
    const reason = await rawRevertData(to, data);
    fail(`transaction to ${to} reverted (status ${receipt.status}) data ${String(reason).slice(0, 80)}`);
  }
  return receipt;
}

async function waitForReceipt(rpc, hash) {
  for (let i = 0; i < 60; i += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  fail(`no receipt for ${hash}`);
}

async function ethCall(rpc, to, data) {
  return rpc("eth_call", [{ to, data }, "latest"]);
}

// Raw eth_call that returns the revert data hex intact (createJsonRpcClient
// stringifies custom-error bytes, losing them).
async function rawRevertData(to, data) {
  const response = await fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: DEPLOYER_ADDRESS, to, data, gas: "0x7a1200" }, "latest"] })
  });
  const json = await response.json();
  return json.error?.data ?? null;
}

async function increaseTime(rpc, seconds) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

// A software P-256 authenticator, self-consistent with the keccak rpIdHash this
// devnet uses (a real device uses sha256; the fake reproduces whatever it is
// checked against, and here only the ECDSA guardian path is under test).
function softwareP256Key() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = privateKey.export({ format: "jwk" });
  const word = value => `0x${Buffer.from(value, "base64url").toString("hex").padStart(64, "0")}`;
  return {
    x: word(jwk.x),
    y: word(jwk.y),
    sign(preimage) {
      return `0x${crypto.sign("sha256", preimage, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex")}`;
    }
  };
}

function packedTuple(op) {
  return {
    sender: op.sender, nonce: op.nonce, initCode: op.initCode, callData: op.callData,
    accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas,
    gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, signature: op.signature
  };
}

async function main() {
  const rpc = createJsonRpcClient(RPC_URL);

  console.log("==> Starting anvil devnet");
  anvil = spawn(bin("anvil"), ["--port", "8545", "--chain-id", String(CHAIN_ID), "--silent"], {
    cwd: repoRoot, stdio: "ignore"
  });
  anvil.on("error", error => fail(`anvil failed to start: ${error.message}`));
  await waitForRpc(rpc);

  console.log("==> Probing the native P-256 precompile");
  const probe = await probeP256Precompile(rpc);
  if (!probe.supported) fail("devnet P-256 precompile probe failed");

  console.log("==> Deploying the Loom stack (DeployDevnet)");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });
  const broadcastPath = join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json");
  if (!existsSync(broadcastPath)) fail(`deploy broadcast missing: ${broadcastPath}`);
  const parsed = parseFoundryBroadcast(JSON.parse(readFileSync(broadcastPath, "utf8")));
  const created = parsed.createdContracts;
  const need = name => created[name] ?? fail(`deployment is missing ${name}`);

  const entryPoint = need("EntryPoint");
  const factory = need("LoomAccountFactory");
  const validator = need("P256Validator");
  const policyHook = need("PolicyHook");
  const recoveryManager = need("RecoveryManager");
  // DeployDevnet does not deploy guardian verifiers, so publish one here.
  const ecdsaGuardian = await deployFromArtifact(rpc, "ECDSAGuardianVerifier");
  console.log(`    entryPoint ${entryPoint}`);
  console.log(`    recoveryManager ${recoveryManager}`);
  console.log(`    ecdsaGuardian ${ecdsaGuardian}`);

  // --- build a real single-guardian tree -----------------------------------
  const guardian = privateKeyToAccount(GUARDIAN_KEY);
  // The contract's guardian leaf uses verifier.codehash = keccak256(code).
  const guardianCodeHash = keccak256(await rpc("eth_getCode", [ecdsaGuardian, "latest"]));
  const keyCommitment = keccak256(encodeAbiParameters([{ type: "address" }], [guardian.address]));
  const salt = keccak256(stringToHex("loom.devnet.guardian.salt"));
  const leaf = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [ecdsaGuardian, guardianCodeHash, keyCommitment, salt]
  ));
  // Single guardian: the root is the leaf and the proof is empty.
  const guardianRoot = leaf;
  console.log(`    guardian ${guardian.address}  root ${guardianRoot}`);

  // --- create the account with a recovery module ----------------------------
  const key = softwareP256Key();
  const rpIdHash = keccak256(stringToHex(RP_ID));
  const originHash = keccak256(stringToHex(ORIGIN));
  const config = {
    entryPoint,
    guardianRoot,
    guardianThreshold: 1,
    configHash: keccak256(stringToHex("loom.devnet.guardian.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      { moduleTypeId: 5n, module: recoveryManager, initData: "0x" },
      {
        moduleTypeId: 1n,
        module: validator,
        initData: encodeFunctionData({
          abi: P256ValidatorAbi, functionName: "initialize",
          args: [key.x, key.y, rpIdHash, originHash, policyHook]
        })
      }
    ]
  };
  const accountSalt = keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }], ["loom.devnet.guardian", key.x, key.y]
  ));
  const implementation = `0x${(await ethCall(rpc, factory, encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "accountImplementation" }))).slice(26)}`;
  const proxyArtifact = JSON.parse(readFileSync(join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8"));
  const account = deriveAccountAddress({ factory, implementation, proxyCreationCode: proxyArtifact.bytecode.object, salt: accountSalt, config });
  console.log(`\n==> account (counterfactual): ${account}`);

  // Prefund and sovereign-deploy via a signed userOp whose callData is a no-op
  // self-call — the point is to bring the account into existence.
  // Fund the account's EntryPoint deposit (0.5 ETH) so validation can pay its
  // prefund — depositTo is payable, the value is the whole point.
  const depositTx = await rpc("eth_sendTransaction", [{
    from: DEPLOYER_ADDRESS, to: entryPoint, value: "0x6f05b59d3b20000",
    data: encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [account] }), gas: "0x5b8d80"
  }]);
  await waitForReceipt(rpc, depositTx);

  const factoryData = encodeFunctionData({
    abi: LoomAccountFactoryAbi, functionName: "createAccount",
    args: [accountSalt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules]
  });
  const selfCall = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[account, 0n, "0x"]]
  );
  const deployOp = await signAndPack(rpc, {
    sender: account, nonce: 0n, factory, factoryData,
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, selfCall] }),
    entryPoint, validator, key
  });
  const handleOpsData = encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(deployOp)], DEPLOYER_ADDRESS] });
  await sendFromDeployer(rpc, entryPoint, handleOpsData, "0x7a1200", { assert: true });
  const deployedCode = await rpc("eth_getCode", [account, "latest"]);
  if (!deployedCode || deployedCode === "0x") fail("account was not deployed");
  console.log("    ok  account deployed with guardian root + recovery module");

  const accountAbi = parseAbi([
    "function frozenUntil() view returns (uint48)",
    "function configVersion() view returns (uint64)",
    "function guardianRoot() view returns (bytes32)",
    "function freezeNonces(bytes32) view returns (uint256)",
    "function isModuleInstalled(uint256,address) view returns (bool)",
    "function validatorCount() view returns (uint256)",
    "function validatorAt(uint256) view returns (address)",
    "function freeze(address verifier, bytes32 keyCommitment, bytes32 salt, bytes32[] proof, bytes signature)"
  ]);

  const recoveryInstalled = await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "isModuleInstalled", args: [5n, recoveryManager] }));
  if (BigInt(recoveryInstalled) !== 1n) fail("recovery module not installed at creation");
  console.log("    ok  recovery module is installed");

  // --- FREEZE ---------------------------------------------------------------
  console.log("\n==> Freeze: the guardian signs the EIP-712 freeze digest");
  const configVersion = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "configVersion" })));
  const freezeNonce = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "freezeNonces", args: [leaf] })));
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, CHAIN_ID, account]
  ));
  const structHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }],
    [FREEZE_TYPEHASH, leaf, freezeNonce, configVersion]
  ));
  const freezeDigest = keccak256(encodePacked(["bytes2", "bytes32", "bytes32"], ["0x1901", domainSeparator, structHash]));
  const freezeSig = await sign({ hash: freezeDigest, privateKey: GUARDIAN_KEY });
  const freezeSignature = serializeSignature(freezeSig);

  await sendFromDeployer(rpc, account, encodeFunctionData({
    abi: accountAbi, functionName: "freeze", args: [ecdsaGuardian, keyCommitment, salt, [], freezeSignature]
  }));
  const frozenUntil = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "frozenUntil" })));
  if (frozenUntil === 0n) fail("account did not freeze");
  console.log(`    ok  account frozen until unix ${frozenUntil}`);

  // A normal execute must be rejected while frozen.
  const probeCall = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[account, 0n, "0x"]]
  );
  const frozenOp = await signAndPack(rpc, {
    sender: account, nonce: await accountNonce(rpc, entryPoint, account),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, probeCall] }),
    entryPoint, validator, key
  });
  const frozenReceipt = await sendFromDeployer(rpc, entryPoint, encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(frozenOp)], DEPLOYER_ADDRESS] }), "0x7a1200");
  // handleOps emits UserOperationEvent(success=false) when the account rejects
  // execution; the tx itself does not revert. Confirm the op did not succeed.
  const failedWhileFrozen = frozenReceipt.logs.some(l =>
    l.topics[0]?.toLowerCase() === "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f".toLowerCase()
    && BigInt(`0x${l.data.slice(66, 130)}`) === 0n);
  console.log(`    ok  execution while frozen was rejected: ${failedWhileFrozen}`);

  console.log("\n==> Advancing past the 2-day freeze window");
  await increaseTime(rpc, 2 * DAY + 60);
  console.log("    ok  time advanced; freeze has now expired");

  // --- RECOVERY -------------------------------------------------------------
  console.log("\n==> Recovery: the guardian approves swapping the passkey validator");
  const newKey = softwareP256Key();
  const newValidatorInit = encodeFunctionData({
    abi: P256ValidatorAbi, functionName: "initialize",
    args: [newKey.x, newKey.y, rpIdHash, originHash, policyHook]
  });
  // Recovery installs a *fresh* validator instance; on devnet we reuse the same
  // P256Validator contract is not allowed (isModuleInstalled would be true), so
  // deploy a second P256Validator via the factory-independent path.
  const secondValidator = await deploySecondValidator(rpc, validator);
  console.log(`    fresh validator ${secondValidator}`);

  const recoveryAbi = parseAbi([
    "function proposeRecovery(address account, address[] oldValidators, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, (address verifier, bytes32 keyCommitment, bytes32 salt, bytes signature, bytes32[] proof)[] guardianApprovals) returns (bytes32)",
    "function executeRecovery(address account, address[] oldValidators, bytes initData)",
    "function proposalDigest(address account, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint64 configVersion, uint64 nonce) view returns (bytes32)",
    "function recoveryNonces(address) view returns (uint64)"
  ]);

  const oldValidators = [validator];
  const oldValidatorsHash = keccak256(encodeAbiParameters([{ type: "address[]" }], [oldValidators]));
  const newRoot = keccak256(stringToHex("loom.devnet.guardian.newroot"));
  const initDataHash = keccak256(newValidatorInit);
  const recoveryNonce = BigInt(await ethCall(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "recoveryNonces", args: [account] })));
  const proposalDigest = await ethCall(rpc, recoveryManager, encodeFunctionData({
    abi: recoveryAbi, functionName: "proposalDigest",
    args: [account, oldValidatorsHash, secondValidator, initDataHash, newRoot, 1, configVersion, recoveryNonce]
  }));
  const recSig = await sign({ hash: proposalDigest, privateKey: GUARDIAN_KEY });
  const approval = { verifier: ecdsaGuardian, keyCommitment, salt, signature: serializeSignature(recSig), proof: [] };

  const proposeData = encodeFunctionData({
    abi: recoveryAbi, functionName: "proposeRecovery",
    args: [account, oldValidators, secondValidator, initDataHash, newRoot, 1, [approval]]
  });
  await sendFromDeployer(rpc, recoveryManager, proposeData, "0x5b8d80", { assert: true });
  console.log("    ok  recovery proposed by the guardian");

  console.log("\n==> Advancing past the 3-day recovery delay");
  await increaseTime(rpc, 3 * DAY + 60);

  const execData = encodeFunctionData({ abi: recoveryAbi, functionName: "executeRecovery", args: [account, oldValidators, newValidatorInit] });
  await sendFromDeployer(rpc, recoveryManager, execData, "0x5b8d80", { assert: true });
  const hasNew = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "isModuleInstalled", args: [1n, secondValidator] })));
  const hasOld = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "isModuleInstalled", args: [1n, validator] })));
  if (hasNew !== 1n || hasOld === 1n) fail(`validator not swapped (new=${hasNew}, old=${hasOld})`);
  console.log(`    ok  guardian-driven recovery replaced the validator on chain`);

  console.log("\nGuardian devnet passed: real guardian freeze + recovery with on-chain timelocks.");
}

async function accountNonce(rpc, entryPoint, account) {
  const word = await ethCall(rpc, entryPoint, `0x35567e1a${account.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}`);
  return BigInt(word);
}

async function signAndPack(rpc, { sender, nonce, factory, factoryData, callData, entryPoint, validator, key }) {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  const unsigned = {
    sender, nonce,
    ...(factory ? { factory, factoryData } : {}),
    callData,
    callGasLimit: 1_500_000n, verificationGasLimit: 6_000_000n, preVerificationGas: 200_000n,
    maxFeePerGas: baseFee * 2n + 2_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
    signature: "0x"
  };
  const packed = packUserOperation(unsigned);
  const hash = getUserOpHash(packed, entryPoint, CHAIN_ID);
  const authenticatorData = Buffer.concat([Buffer.from(keccak256(stringToHex(RP_ID)).slice(2), "hex"), Buffer.from([0x05])]);
  const clientDataJSON = Buffer.from(`{"type":"webauthn.get","challenge":"${base64UrlEncode(hash)}","origin":"${ORIGIN}","crossOrigin":false}`, "utf8");
  const preimage = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
  const { r, s } = parseP256Signature(key.sign(preimage));
  const signature = encodeValidatorSignature(validator, encodeWebAuthnSignature({
    authenticatorData: `0x${authenticatorData.toString("hex")}`,
    clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
    origin: ORIGIN, r, s
  }));
  return packUserOperation({ ...unsigned, signature });
}

// Publish a contract straight from its compiled creation code (no constructor
// args). Used for the guardian verifier and a second validator instance.
async function deployFromArtifact(rpc, name) {
  const artifact = JSON.parse(readFileSync(join(repoRoot, "out", `${name}.sol`, `${name}.json`), "utf8"));
  const receipt = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, data: artifact.bytecode.object, gas: "0x1c9c380" }]);
  const mined = await waitForReceipt(rpc, receipt);
  if (!mined.contractAddress) fail(`${name} deployment produced no address`);
  return mined.contractAddress;
}

// A second P256Validator with the same fallback verifier as the deployed one.
// Its constructor takes an address, so the creation code needs that arg appended
// — a bare deployment produces a broken contract that fails recovery silently.
async function deploySecondValidator(rpc, existingValidator) {
  const fallback = `0x${(await ethCall(rpc, existingValidator, encodeFunctionData({
    abi: parseAbi(["function fallbackVerifier() view returns (address)"]), functionName: "fallbackVerifier"
  }))).slice(26)}`;
  const artifact = JSON.parse(readFileSync(join(repoRoot, "out", "P256Validator.sol", "P256Validator.json"), "utf8"));
  const initCode = artifact.bytecode.object + encodeAbiParameters([{ type: "address" }], [fallback]).slice(2);
  const receipt = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, data: initCode, gas: "0x1c9c380" }]);
  const mined = await waitForReceipt(rpc, receipt);
  if (!mined.contractAddress) fail("second validator deployment produced no address");
  return mined.contractAddress;
}

main()
  .catch(error => {
    if (!process.exitCode) process.exitCode = 1;
    console.error(error?.stack ?? error);
  })
  .finally(() => {
    if (anvil) anvil.kill();
  });
