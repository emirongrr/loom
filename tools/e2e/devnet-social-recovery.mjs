// Social recovery on a live devnet: three guardians, any two of them, signing
// independently, restore an account to a new key — the account address never
// changes.
//
//   npm run e2e:social-recovery
//
// This is the scenario a wallet holder actually pictures: I set three guardians
// with a threshold of two when the account was created, I later lost my passkey,
// I made a new one, and once two of my three guardians approve — each on their
// own, without coordinating — the same account is mine again under the new key.
//
// It is proved end to end with real keys and the real on-chain three-day delay,
// advanced by anvil:
//   1. Create an account with a real three-guardian merkle tree (threshold 2)
//      and a recovery module.
//   2. Generate a fresh passkey — the "new owner" — and a fresh validator for it.
//   3. Show one approval alone is rejected (below the threshold).
//   4. Two of the three guardians sign the same proposal digest independently;
//      submit proposeRecovery with just those two.
//   5. Advance past the recovery delay; executeRecovery.
//   6. Assert the account address is unchanged and now answers to the new key.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpcClient, parseFoundryBroadcast, probeP256Precompile } from "../../packages/deployment/src/index.js";
import {
  base64UrlEncode, deriveAccountAddress, encodeValidatorSignature, encodeWebAuthnSignature,
  EntryPointAbi, getUserOpHash, LoomAccountAbi, LoomAccountFactoryAbi, P256RecoveryValidatorFactoryAbi, P256ValidatorAbi,
  packUserOperation, parseP256Signature
} from "../../packages/core/dist/index.js";
import {
  decodeErrorResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi,
  serializeSignature, stringToHex
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337n;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// anvil accounts 1, 2 and 3 stand in for three independent guardians.
const GUARDIAN_KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
];
const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";
const ZERO32 = `0x${"00".repeat(32)}`;
const DAY = 24 * 60 * 60;

let anvil;

function bin(name) {
  const local = join(repoRoot, "node_modules", "@foundry-rs", `${name}-win32-amd64`, "bin", `${name}.exe`);
  return existsSync(local) ? local : name;
}
function fail(message) { console.error(`\nFAIL ${message}`); process.exitCode = 1; throw new Error(message); }

async function waitForRpc(rpc, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try { await rpc("eth_chainId", []); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  fail("anvil did not become ready");
}
function forgeScript(target, env) {
  const result = spawnSync(bin("forge"), ["script", target, "--rpc-url", RPC_URL, "--broadcast", "--skip-simulation", "-vvvv"],
    { cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8" });
  if (result.status !== 0) fail(`forge script ${target} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}
async function waitForReceipt(rpc, hash) {
  for (let i = 0; i < 60; i += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(r => setTimeout(r, 200));
  }
  fail(`no receipt for ${hash}`);
}
async function rawRevertData(to, data) {
  const response = await fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: DEPLOYER_ADDRESS, to, data, gas: "0x7a1200" }, "latest"] })
  });
  return (await response.json()).error?.data ?? null;
}
async function sendFromDeployer(rpc, to, data, gas = "0x5b8d80", { assert = false } = {}) {
  const tx = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to, data, gas }]);
  const receipt = await waitForReceipt(rpc, tx);
  if (assert && receipt.status !== "0x1") fail(`tx to ${to} reverted; data ${String(await rawRevertData(to, data)).slice(0, 90)}`);
  return receipt;
}
const ethCall = (rpc, to, data) => rpc("eth_call", [{ to, data }, "latest"]);
async function increaseTime(rpc, seconds) { await rpc("evm_increaseTime", [seconds]); await rpc("evm_mine", []); }

function softwareP256Key() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const word = v => `0x${Buffer.from(v, "base64url").toString("hex").padStart(64, "0")}`;
  return {
    x: word(jwk.x), y: word(jwk.y),
    sign: preimage => `0x${crypto.sign("sha256", preimage, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex")}`
  };
}
const packedTuple = op => ({
  sender: op.sender, nonce: op.nonce, initCode: op.initCode, callData: op.callData,
  accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas,
  gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, signature: op.signature
});

// A guardian merkle tree with the leaf encoding the contract uses. Sorted-pair
// hashing matches OpenZeppelin's MerkleProof; proofs are the sibling hashes up
// to the root.
function buildTree(leaves) {
  const sorted = [...leaves].sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1));
  let layer = sorted.map(l => l.leaf);
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i], right = layer[i + 1] ?? left;
      const [a, b] = BigInt(left) <= BigInt(right) ? [left, right] : [right, left];
      next.push(keccak256(`0x${a.slice(2)}${b.slice(2)}`));
    }
    layers.push(next);
    layer = next;
  }
  return { root: layer[0], layers, sorted };
}
function proofFor(layers, leaf) {
  let index = layers[0].indexOf(leaf);
  const proof = [];
  for (let level = 0; level < layers.length - 1; level += 1) {
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    // The tree duplicates an unpaired final node, so its proof must carry that
    // same hash. Omitting it would prove against a promoted-node tree instead.
    proof.push(sibling < layers[level].length ? layers[level][sibling] : layers[level][index]);
    index = Math.floor(index / 2);
  }
  return proof;
}

async function deployFromArtifact(rpc, name, constructorArgsHex = "") {
  const artifact = JSON.parse(readFileSync(join(repoRoot, "out", `${name}.sol`, `${name}.json`), "utf8"));
  const receipt = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, data: artifact.bytecode.object + constructorArgsHex, gas: "0x1c9c380" }]);
  const mined = await waitForReceipt(rpc, receipt);
  if (!mined.contractAddress) fail(`${name} deployment produced no address`);
  return mined.contractAddress;
}
async function accountNonce(rpc, entryPoint, account) {
  return BigInt(await ethCall(rpc, entryPoint, `0x35567e1a${account.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}`));
}

// Sign a user operation with the account's current passkey, as an authenticator
// would. Proves the account answers to whichever key controls it.
async function signOp(rpc, { sender, nonce, factory, factoryData, callData, entryPoint, validator, key }) {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  const unsigned = {
    sender, nonce, ...(factory ? { factory, factoryData } : {}), callData,
    callGasLimit: 1_500_000n, verificationGasLimit: 6_000_000n, preVerificationGas: 200_000n,
    maxFeePerGas: baseFee * 2n + 2_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, signature: "0x"
  };
  const packed = packUserOperation(unsigned);
  const hash = getUserOpHash(packed, entryPoint, CHAIN_ID);
  const authenticatorData = Buffer.concat([Buffer.from(keccak256(stringToHex(RP_ID)).slice(2), "hex"), Buffer.from([0x05])]);
  const clientDataJSON = Buffer.from(`{"type":"webauthn.get","challenge":"${base64UrlEncode(hash)}","origin":"${ORIGIN}","crossOrigin":false}`, "utf8");
  const preimage = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
  const { r, s } = parseP256Signature(key.sign(preimage));
  const signature = encodeValidatorSignature(validator, encodeWebAuthnSignature({
    authenticatorData: `0x${authenticatorData.toString("hex")}`, clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
    origin: ORIGIN, r, s
  }));
  return packUserOperation({ ...unsigned, signature });
}

async function main() {
  const rpc = createJsonRpcClient(RPC_URL);
  console.log("==> Starting anvil devnet");
  anvil = spawn(bin("anvil"), ["--port", "8545", "--chain-id", String(CHAIN_ID), "--silent"], { cwd: repoRoot, stdio: "ignore" });
  anvil.on("error", e => fail(`anvil failed to start: ${e.message}`));
  await waitForRpc(rpc);

  const probe = await probeP256Precompile(rpc);
  if (!probe.supported) fail("devnet P-256 precompile probe failed");

  console.log("==> Deploying the Loom stack");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });
  const parsed = parseFoundryBroadcast(JSON.parse(readFileSync(join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8")));
  const created = parsed.createdContracts;
  const need = n => created[n] ?? fail(`deployment is missing ${n}`);
  const entryPoint = need("EntryPoint"), factory = need("LoomAccountFactory"), validator = need("P256Validator");
  const recoveryValidatorFactory = need("P256RecoveryValidatorFactory");
  const policyHook = need("PolicyHook"), recoveryManager = need("RecoveryManager");
  const ecdsaGuardian = await deployFromArtifact(rpc, "ECDSAGuardianVerifier");

  // --- three guardians, threshold two ---------------------------------------
  const guardians = GUARDIAN_KEYS.map(privateKeyToAccount);
  const guardianCodeHash = keccak256(await rpc("eth_getCode", [ecdsaGuardian, "latest"]));
  const salt = keccak256(stringToHex("loom.devnet.social.salt"));
  const guardianLeaves = guardians.map(g => {
    const keyCommitment = keccak256(encodeAbiParameters([{ type: "address" }], [g.address]));
    return {
      address: g.address, account: g, keyCommitment,
      leaf: keccak256(encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [ecdsaGuardian, guardianCodeHash, keyCommitment, salt]))
    };
  });
  const tree = buildTree(guardianLeaves);
  const THRESHOLD = 2;
  console.log(`==> 3 guardians, threshold ${THRESHOLD}:`);
  guardians.forEach((g, i) => console.log(`    guardian ${i + 1}: ${g.address}`));
  console.log(`    guardian root: ${tree.root}`);

  // --- create the account with that root + a recovery module ----------------
  const key = softwareP256Key();
  const rpIdHash = keccak256(stringToHex(RP_ID));
  const originHash = keccak256(stringToHex(ORIGIN));
  const config = {
    entryPoint, guardianRoot: tree.root, guardianThreshold: THRESHOLD,
    configHash: keccak256(stringToHex("loom.devnet.social.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      { moduleTypeId: 5n, module: recoveryManager, initData: "0x" },
      { moduleTypeId: 1n, module: validator, initData: encodeFunctionData({
        abi: P256ValidatorAbi, functionName: "initialize", args: [key.x, key.y, rpIdHash, originHash, policyHook] }) }
    ]
  };
  const accountSalt = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }], ["loom.devnet.social", key.x, key.y]));
  const implementation = `0x${(await ethCall(rpc, factory, encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "accountImplementation" }))).slice(26)}`;
  const proxyArtifact = JSON.parse(readFileSync(join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8"));
  const account = deriveAccountAddress({ factory, implementation, proxyCreationCode: proxyArtifact.bytecode.object, salt: accountSalt, config });
  console.log(`\n==> account: ${account}`);

  const depositTx = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to: entryPoint, value: "0x6f05b59d3b20000",
    data: encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [account] }), gas: "0x5b8d80" }]);
  await waitForReceipt(rpc, depositTx);

  const selfCall = encodeAbiParameters([{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }], [[account, 0n, "0x"]]);
  const deployOp = await signOp(rpc, {
    sender: account, nonce: 0n, factory,
    factoryData: encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "createAccount",
      args: [accountSalt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules] }),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, selfCall] }),
    entryPoint, validator, key
  });
  await sendFromDeployer(rpc, entryPoint, encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(deployOp)], DEPLOYER_ADDRESS] }), "0x7a1200", { assert: true });
  if ((await rpc("eth_getCode", [account, "latest"])) === "0x") fail("account not deployed");
  console.log("    ok  account created with 3-guardian root and a recovery module");

  // --- the new owner: a fresh passkey, and a fresh validator for it ---------
  console.log("\n==> Lost the passkey; generating a new one (same account, new key)");
  const newKey = softwareP256Key();
  const newValidatorInit = encodeFunctionData({ abi: P256ValidatorAbi, functionName: "initialize",
    args: [newKey.x, newKey.y, rpIdHash, originHash, policyHook] });

  const recoveryAbi = parseAbi([
    "function proposeRecovery(address account, address[] oldValidators, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, (address verifier, bytes32 keyCommitment, bytes32 salt, bytes signature, bytes32[] proof)[] guardianApprovals) returns (bytes32)",
    "function executeRecovery(address account, address[] oldValidators, bytes initData)",
    "function proposalDigest(address account, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint64 configVersion, uint64 nonce) view returns (bytes32)",
    "function recoveryNonces(address) view returns (uint64)"
  ]);
  const accountAbi = parseAbi([
    "function configVersion() view returns (uint64)",
    "function isModuleInstalled(uint256,address) view returns (bool)",
    "function guardianRoot() view returns (bytes32)"
  ]);

  const initDataHash = keccak256(newValidatorInit);
  const recoveryNonce = BigInt(await ethCall(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "recoveryNonces", args: [account] })));
  const predicted = await ethCall(rpc, recoveryValidatorFactory, encodeFunctionData({
    abi: P256RecoveryValidatorFactoryAbi,
    functionName: "getAddress",
    args: [account, recoveryNonce, initDataHash]
  }));
  const newValidator = `0x${predicted.slice(-40)}`;
  const provisionTx = await rpc("eth_sendTransaction", [{
    from: DEPLOYER_ADDRESS,
    to: recoveryValidatorFactory,
    data: encodeFunctionData({
      abi: P256RecoveryValidatorFactoryAbi,
      functionName: "deploy",
      args: [account, recoveryNonce, initDataHash]
    }),
    gas: "0x4c4b40"
  }]);
  await waitForReceipt(rpc, provisionTx);
  if ((await rpc("eth_getCode", [newValidator, "latest"])) === "0x") fail("recovery validator not provisioned");

  const oldValidators = [validator];
  const oldValidatorsHash = keccak256(encodeAbiParameters([{ type: "address[]" }], [oldValidators]));
  const newRoot = keccak256(stringToHex("loom.devnet.social.newroot"));
  const configVersion = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "configVersion" })));

  // The one digest everyone signs. It commits to the new key, so a guardian who
  // signs it is approving this exact recovery and nothing else.
  const digest = await ethCall(rpc, recoveryManager, encodeFunctionData({
    abi: recoveryAbi, functionName: "proposalDigest",
    args: [account, oldValidatorsHash, newValidator, initDataHash, newRoot, THRESHOLD, configVersion, recoveryNonce]
  }));

  // Each guardian signs on their own — separate keys, no shared state. Build an
  // approval for whichever guardians we choose.
  const approvalFor = async i => {
    const leaf = guardianLeaves[i];
    const s = await sign({ hash: digest, privateKey: GUARDIAN_KEYS[i] });
    return { verifier: ecdsaGuardian, keyCommitment: leaf.keyCommitment, salt, signature: serializeSignature(s), proof: proofFor(tree.layers, leaf.leaf) };
  };

  // --- one approval alone must be refused (below threshold) -----------------
  console.log("\n==> One guardian alone (below the threshold of 2)");
  const single = [await approvalFor(0)];
  const singleData = encodeFunctionData({ abi: recoveryAbi, functionName: "proposeRecovery",
    args: [account, oldValidators, newValidator, initDataHash, newRoot, THRESHOLD, single] });
  const singleRevert = await rawRevertData(recoveryManager, singleData);
  console.log(`    ok  refused with ${singleRevert && singleRevert !== "0x" ? "a revert" : "an empty revert"} — one signature is not enough`);
  if (!singleRevert || singleRevert === "0x") fail("a single approval should have reverted");

  // --- two of the three, chosen independently: guardians 1 and 3 ------------
  console.log("\n==> Guardians 1 and 3 approve independently (guardian 2 does nothing)");
  const two = [await approvalFor(0), await approvalFor(2)]
    // proposeRecovery requires approvals ordered by strictly increasing leaf.
    .sort((a, b) => (BigInt(guardianLeaves.find(l => l.keyCommitment === a.keyCommitment).leaf)
      < BigInt(guardianLeaves.find(l => l.keyCommitment === b.keyCommitment).leaf) ? -1 : 1));
  await sendFromDeployer(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "proposeRecovery",
    args: [account, oldValidators, newValidator, initDataHash, newRoot, THRESHOLD, two] }), "0x5b8d80", { assert: true });
  console.log("    ok  recovery proposed with two independent approvals");

  console.log("\n==> Advancing past the 3-day recovery delay");
  await increaseTime(rpc, 3 * DAY + 60);
  await sendFromDeployer(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "executeRecovery",
    args: [account, oldValidators, newValidatorInit] }), "0x5b8d80", { assert: true });

  const hasNew = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "isModuleInstalled", args: [1n, newValidator] })));
  const hasOld = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "isModuleInstalled", args: [1n, validator] })));
  if (hasNew !== 1n || hasOld === 1n) fail(`validator not swapped (new=${hasNew}, old=${hasOld})`);
  console.log("    ok  the account now answers to the new key — same address, recovered");

  // --- prove the account works under the new key ----------------------------
  console.log("\n==> The new passkey drives the account");
  const probeCall = encodeAbiParameters([{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }], [[account, 0n, "0x"]]);
  const opNonce = await accountNonce(rpc, entryPoint, account);
  const newOp = await signOp(rpc, {
    sender: account, nonce: opNonce,
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, probeCall] }),
    entryPoint, validator: newValidator, key: newKey
  });
  const receipt = await sendFromDeployer(rpc, entryPoint, encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(newOp)], DEPLOYER_ADDRESS] }), "0x7a1200", { assert: true });
  const success = receipt.logs.some(l => l.topics[0]?.toLowerCase() === "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f".toLowerCase()
    && BigInt(`0x${l.data.slice(66, 130)}`) === 1n);
  if (!success) fail("the new key could not drive the recovered account");
  console.log(`    ok  account ${account} operated by the new passkey`);

  console.log("\nSocial recovery passed: 2 of 3 independent approvals, same address, new key.");
}

main()
  .catch(error => { if (!process.exitCode) process.exitCode = 1; console.error(error?.stack ?? error); })
  .finally(() => { if (anvil) anvil.kill(); });
