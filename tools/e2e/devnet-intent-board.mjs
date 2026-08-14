// Asynchronous guardian approval on a live devnet: one guardian publishes on
// chain, another signs privately, and a stranger who is neither a guardian nor
// the account owner assembles both and finishes the recovery.
//
//   npm run e2e:intent-board
//
// `devnet-social-recovery.mjs` already proves the threshold, the delay and the
// preserved address when one party holds every approval. This proves the part
// that needs `RecoveryIntentBoard` (ADR-0024): approvals that never met on one
// device, and a guardian who is never contacted directly.
//
//   1. Create an account with three guardians, threshold two.
//   2. A non-guardian floods announcements. Nothing authoritative moves, and a
//      forged approval is refused.
//   3. Guardian 1 publishes an approval on chain, paying their own gas.
//   4. Read it back through the SDK's board reader over real `eth_getLogs`, and
//      assert the decoded tuple equals the one the guardian published — the
//      parity the SDK's unit tests cannot show, because those encode their own
//      fixtures with the same library that decodes them.
//   5. Guardian 3 signs privately and never sends a transaction.
//   6. An independent submitter combines the published and the private approval
//      and proposes. Neither guardian finalises.
//   7. Advance the contract delay, execute, and drive the account with the new
//      key at the same address.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpcClient, parseFoundryBroadcast, probeP256Precompile } from "../../packages/deployment/src/index.js";
import { buildGuardianTree, guardianLeaf } from "../../packages/guardian/src/index.js";
import {
  base64UrlEncode, deriveAccountAddress, encodeValidatorSignature, encodeWebAuthnSignature,
  EntryPointAbi, getUserOpHash, LoomAccountAbi, LoomAccountFactoryAbi, P256RecoveryValidatorFactoryAbi,
  P256ValidatorAbi, packUserOperation, parseP256Signature
} from "../../packages/core/dist/index.js";
import { createRecoveryIntentBoardReader } from "../../packages/sdk/dist/recovery.js";
import {
  encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, serializeSignature, stringToHex
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337n;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GUARDIAN_KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
];
// Neither of these holds a guardian key or the account's passkey.
const SUBMITTER_ADDRESS = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const GRIEFER_ADDRESS = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";
const ZERO32 = `0x${"00".repeat(32)}`;
const DAY = 24 * 60 * 60;
const THRESHOLD = 2;
const ANNOUNCEMENT_FLOOD = 8;

let anvil;

function bin(name) {
  const local = join(repoRoot, "node_modules", "@foundry-rs", `${name}-win32-amd64`, "bin", `${name}.exe`);
  return existsSync(local) ? local : name;
}
function fail(message) { console.error(`\nFAIL ${message}`); process.exitCode = 1; throw new Error(message); }
function ok(message) { console.log(`    ok  ${message}`); }

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
async function send(rpc, from, to, data, gas = "0x5b8d80", { assert = true } = {}) {
  const tx = await rpc("eth_sendTransaction", [{ from, to, data, gas }]);
  const receipt = await waitForReceipt(rpc, tx);
  if (assert && receipt.status !== "0x1") fail(`tx from ${from} to ${to} reverted`);
  return receipt;
}
const ethCall = (rpc, to, data) => rpc("eth_call", [{ to, data }, "latest"]);
async function increaseTime(rpc, seconds) { await rpc("evm_increaseTime", [seconds]); await rpc("evm_mine", []); }
async function mine(rpc, blocks) { for (let i = 0; i < blocks; i += 1) await rpc("evm_mine", []); }

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

async function deployFromArtifact(rpc, name) {
  const artifact = JSON.parse(readFileSync(join(repoRoot, "out", `${name}.sol`, `${name}.json`), "utf8"));
  const tx = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, data: artifact.bytecode.object, gas: "0x1c9c380" }]);
  const mined = await waitForReceipt(rpc, tx);
  if (!mined.contractAddress) fail(`${name} deployment produced no address`);
  return mined.contractAddress;
}
async function accountNonce(rpc, entryPoint, account) {
  return BigInt(await ethCall(rpc, entryPoint, `0x35567e1a${account.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}`));
}

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
  return packUserOperation({ ...unsigned, signature: encodeValidatorSignature(validator, encodeWebAuthnSignature({
    authenticatorData: `0x${authenticatorData.toString("hex")}`, clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
    origin: ORIGIN, r, s
  })) });
}

/** The SDK's log transport, backed by the devnet's own JSON-RPC. */
function logTransport(rpc) {
  return {
    async getBlockNumber() { return BigInt(await rpc("eth_blockNumber", [])); },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      const logs = await rpc("eth_getLogs", [{
        address, topics, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`
      }]);
      return logs.map(entry => ({
        address: entry.address, topics: entry.topics, data: entry.data,
        blockNumber: BigInt(entry.blockNumber), blockHash: entry.blockHash,
        logIndex: Number(BigInt(entry.logIndex)), transactionHash: entry.transactionHash,
        removed: entry.removed === true
      }));
    }
  };
}

const boardAbi = parseAbi([
  "function announce(address account, address recoveryManager, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint48 expiresAt) returns (bytes32)",
  "function publishApproval(address account, address recoveryManager, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, (address verifier, bytes32 keyCommitment, bytes32 salt, bytes signature, bytes32[] proof)[] approvals) returns (bytes32)"
]);
const recoveryAbi = parseAbi([
  "function proposeRecovery(address account, address[] oldValidators, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, (address verifier, bytes32 keyCommitment, bytes32 salt, bytes signature, bytes32[] proof)[] guardianApprovals) returns (bytes32)",
  "function executeRecovery(address account, address[] oldValidators, bytes initData)",
  "function proposalDigest(address account, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 newGuardianThreshold, uint64 configVersion, uint64 nonce) view returns (bytes32)",
  "function recoveryNonces(address) view returns (uint64)",
  "function pendingRecoveries(address) view returns (bytes32,address,bytes32,bytes32,uint8,uint48,uint48,uint64,uint64)"
]);
const accountAbi = parseAbi([
  "function configVersion() view returns (uint64)",
  "function isModuleInstalled(uint256,address) view returns (bool)",
  "function guardianRoot() view returns (bytes32)"
]);

async function main() {
  const rpc = createJsonRpcClient(RPC_URL);
  console.log("==> Starting anvil devnet");
  anvil = spawn(bin("anvil"), ["--port", "8545", "--chain-id", String(CHAIN_ID), "--silent"], { cwd: repoRoot, stdio: "ignore" });
  anvil.on("error", e => fail(`anvil failed to start: ${e.message}`));
  await waitForRpc(rpc);
  if (!(await probeP256Precompile(rpc)).supported) fail("devnet P-256 precompile probe failed");

  console.log("==> Deploying the Loom stack and the intent board");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });
  const created = parseFoundryBroadcast(JSON.parse(readFileSync(join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8"))).createdContracts;
  const need = n => created[n] ?? fail(`deployment is missing ${n}`);
  const entryPoint = need("EntryPoint"), factory = need("LoomAccountFactory"), validator = need("P256Validator");
  const recoveryValidatorFactory = need("P256RecoveryValidatorFactory");
  const policyHook = need("PolicyHook"), recoveryManager = need("RecoveryManager");
  const ecdsaGuardian = await deployFromArtifact(rpc, "ECDSAGuardianVerifier");
  const board = await deployFromArtifact(rpc, "RecoveryIntentBoard");
  console.log(`    board: ${board}`);

  const guardians = GUARDIAN_KEYS.map(privateKeyToAccount);
  const guardianCodeHash = keccak256(await rpc("eth_getCode", [ecdsaGuardian, "latest"]));
  const salt = keccak256(stringToHex("loom.devnet.board.salt"));
  const guardianLeaves = guardians.map(g => {
    const keyCommitment = keccak256(encodeAbiParameters([{ type: "address" }], [g.address]));
    const input = { verifier: ecdsaGuardian, verifierCodeHash: guardianCodeHash, keyCommitment, salt };
    return { address: g.address, keyCommitment, leaf: guardianLeaf(input), ...input };
  });
  const tree = buildGuardianTree(guardianLeaves);
  console.log(`==> 3 guardians, threshold ${THRESHOLD}; root ${tree.root}`);

  const key = softwareP256Key();
  const rpIdHash = keccak256(stringToHex(RP_ID));
  const originHash = keccak256(stringToHex(ORIGIN));
  const config = {
    entryPoint, guardianRoot: tree.root, guardianThreshold: THRESHOLD,
    configHash: keccak256(stringToHex("loom.devnet.board.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      { moduleTypeId: 5n, module: recoveryManager, initData: "0x" },
      { moduleTypeId: 1n, module: validator, initData: encodeFunctionData({
        abi: P256ValidatorAbi, functionName: "initialize", args: [key.x, key.y, rpIdHash, originHash, policyHook] }) }
    ]
  };
  const accountSalt = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }], ["loom.devnet.board", key.x, key.y]));
  const implementation = `0x${(await ethCall(rpc, factory, encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "accountImplementation" }))).slice(26)}`;
  const proxyArtifact = JSON.parse(readFileSync(join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8"));
  const account = deriveAccountAddress({ factory, implementation, proxyCreationCode: proxyArtifact.bytecode.object, salt: accountSalt, config });
  console.log(`\n==> account: ${account}`);

  await waitForReceipt(rpc, await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to: entryPoint, value: "0x6f05b59d3b20000",
    data: encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [account] }), gas: "0x5b8d80" }]));
  const selfCall = encodeAbiParameters([{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }], [[account, 0n, "0x"]]);
  const deployOp = await signOp(rpc, {
    sender: account, nonce: 0n, factory,
    factoryData: encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "createAccount",
      args: [accountSalt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules] }),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, selfCall] }),
    entryPoint, validator, key
  });
  await send(rpc, DEPLOYER_ADDRESS, entryPoint, encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(deployOp)], DEPLOYER_ADDRESS] }), "0x7a1200");
  if ((await rpc("eth_getCode", [account, "latest"])) === "0x") fail("account not deployed");
  ok("account created with a 3-guardian root and a recovery module");

  // --- the replacement key and its validator --------------------------------
  const newKey = softwareP256Key();
  const newValidatorInit = encodeFunctionData({ abi: P256ValidatorAbi, functionName: "initialize",
    args: [newKey.x, newKey.y, rpIdHash, originHash, policyHook] });
  const initDataHash = keccak256(newValidatorInit);
  const recoveryNonce = BigInt(await ethCall(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "recoveryNonces", args: [account] })));
  const newValidator = `0x${(await ethCall(rpc, recoveryValidatorFactory, encodeFunctionData({
    abi: P256RecoveryValidatorFactoryAbi, functionName: "getAddress", args: [account, recoveryNonce, initDataHash] }))).slice(-40)}`;
  await send(rpc, DEPLOYER_ADDRESS, recoveryValidatorFactory, encodeFunctionData({
    abi: P256RecoveryValidatorFactoryAbi, functionName: "deploy", args: [account, recoveryNonce, initDataHash] }), "0x4c4b40");

  const oldValidators = [validator];
  const oldValidatorsHash = keccak256(encodeAbiParameters([{ type: "address[]" }], [oldValidators]));
  const newRoot = keccak256(stringToHex("loom.devnet.board.newroot"));
  const configVersion = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "configVersion" })));
  const digest = await ethCall(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "proposalDigest",
    args: [account, oldValidatorsHash, newValidator, initDataHash, newRoot, THRESHOLD, configVersion, recoveryNonce] }));

  const approvalFor = async i => {
    const leaf = guardianLeaves[i];
    const s = await sign({ hash: digest, privateKey: GUARDIAN_KEYS[i] });
    return { verifier: ecdsaGuardian, keyCommitment: leaf.keyCommitment, salt, signature: serializeSignature(s), proof: tree.proofFor(leaf.leaf) };
  };
  const boardArgs = approvals => [account, recoveryManager, oldValidatorsHash, newValidator, initDataHash, newRoot, THRESHOLD, approvals];

  // --- a non-guardian floods announcements ----------------------------------
  console.log(`\n==> A stranger floods ${ANNOUNCEMENT_FLOOD} announcements for this account`);
  const noncesBefore = await ethCall(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "recoveryNonces", args: [account] }));
  const rootBefore = await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "guardianRoot" }));
  for (let i = 0; i < ANNOUNCEMENT_FLOOD; i += 1) {
    await send(rpc, GRIEFER_ADDRESS, board, encodeFunctionData({ abi: boardAbi, functionName: "announce",
      args: [account, recoveryManager, oldValidatorsHash, newValidator, initDataHash, newRoot, THRESHOLD, BigInt(2_000_000_000 + i)] }), "0x2dc6c0");
  }
  const pendingAfterFlood = await ethCall(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "pendingRecoveries", args: [account] }));
  // Field 5 of PendingRecovery is readyAt; non-zero means a recovery is pending.
  if (BigInt(`0x${pendingAfterFlood.slice(2 + 64 * 5, 2 + 64 * 6)}`) !== 0n) fail("an announcement created a pending recovery");
  if (await ethCall(rpc, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "recoveryNonces", args: [account] })) !== noncesBefore) fail("an announcement advanced the recovery nonce");
  if (await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "guardianRoot" })) !== rootBefore) fail("an announcement changed the guardian root");
  ok("no pending recovery, no nonce change, no root change");

  // --- a non-guardian cannot publish an approval ----------------------------
  const forged = { ...(await approvalFor(0)), keyCommitment: keccak256(encodeAbiParameters([{ type: "address" }], [GRIEFER_ADDRESS])) };
  const forgedReceipt = await send(rpc, GRIEFER_ADDRESS, board, encodeFunctionData({ abi: boardAbi, functionName: "publishApproval", args: boardArgs([forged]) }), "0x2dc6c0", { assert: false });
  if (forgedReceipt.status === "0x1") fail("a non-guardian published an approval");
  ok("a forged approval is refused by the board");

  // --- guardian 1 publishes on chain, paying their own gas ------------------
  console.log("\n==> Guardian 1 publishes an approval on chain");
  const published = await approvalFor(0);
  await send(rpc, guardians[0].address, board, encodeFunctionData({ abi: boardAbi, functionName: "publishApproval", args: boardArgs([published]) }), "0x2dc6c0");
  await mine(rpc, 6);
  ok(`published by ${guardians[0].address}, who pays their own gas and gains no authority`);

  // --- read it back through the SDK over real logs --------------------------
  console.log("\n==> Reading the approval back through the SDK board reader");
  const snapshot = await createRecoveryIntentBoardReader({
    chainId: Number(CHAIN_ID), account, board, recoveryManager, logTransport: logTransport(rpc)
  }).discover({ fromBlock: 0n });

  if (snapshot.approvals.length !== 1) fail(`expected exactly 1 discovered approval, got ${snapshot.approvals.length}`);
  if (snapshot.confirmedApprovalCount !== 1) fail("the published approval was not reported as confirmed");
  if (snapshot.announcements.length !== ANNOUNCEMENT_FLOOD) fail(`expected ${ANNOUNCEMENT_FLOOD} announcements, got ${snapshot.announcements.length}`);
  const discovered = snapshot.approvals[0];
  if (discovered.status !== "unverified") fail("a discovered approval must never be reported as verified");

  // The parity the SDK's unit tests cannot show: a log this decoder never
  // encoded, produced by the contract, rebuilds the exact tuple the manager
  // will accept.
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!same(discovered.approval.verifier, published.verifier)
    || !same(discovered.approval.keyCommitment, published.keyCommitment)
    || !same(discovered.approval.salt, published.salt)
    || !same(discovered.approval.signature, published.signature)
    || discovered.approval.proof.length !== published.proof.length
    || !discovered.approval.proof.every((item, i) => same(item, published.proof[i]))) {
    fail("the decoded approval does not match what the guardian published");
  }
  ok("the decoded tuple is byte-identical to the guardian's published approval");

  // --- guardian 3 signs privately and sends nothing -------------------------
  console.log("\n==> Guardian 3 signs privately (no transaction)");
  const privateApproval = await approvalFor(2);
  const guardian3Balance = BigInt(await rpc("eth_getBalance", [guardians[2].address, "latest"]));
  ok("signed locally; the private guardian stays off chain");

  // --- an independent submitter finalises -----------------------------------
  console.log("\n==> An independent submitter assembles both approvals and proposes");
  const leafOf = approval => guardianLeaves.find(l => same(l.keyCommitment, approval.keyCommitment)).leaf;
  const bundle = [
    {
      verifier: discovered.approval.verifier,
      keyCommitment: discovered.approval.keyCommitment,
      salt: discovered.approval.salt,
      signature: discovered.approval.signature,
      proof: [...discovered.approval.proof]
    },
    privateApproval
  ].sort((a, b) => (BigInt(leafOf(a)) < BigInt(leafOf(b)) ? -1 : 1));

  await send(rpc, SUBMITTER_ADDRESS, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "proposeRecovery",
    args: [account, oldValidators, newValidator, initDataHash, newRoot, THRESHOLD, bundle] }), "0x5b8d80");
  ok(`proposed by ${SUBMITTER_ADDRESS}, who is neither a guardian nor the owner`);
  if (BigInt(await rpc("eth_getBalance", [guardians[2].address, "latest"])) !== guardian3Balance) fail("the private guardian spent gas");
  ok("guardian 3's balance is unchanged — they never touched the chain");

  // --- delay, execute, and prove the account moved --------------------------
  console.log("\n==> Advancing past the 3-day delay and executing");
  await increaseTime(rpc, 3 * DAY + 60);
  await send(rpc, SUBMITTER_ADDRESS, recoveryManager, encodeFunctionData({ abi: recoveryAbi, functionName: "executeRecovery",
    args: [account, oldValidators, newValidatorInit] }), "0x5b8d80");

  const hasNew = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "isModuleInstalled", args: [1n, newValidator] })));
  const hasOld = BigInt(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "isModuleInstalled", args: [1n, validator] })));
  if (hasNew !== 1n || hasOld === 1n) fail(`validator not swapped (new=${hasNew}, old=${hasOld})`);
  if (same(await ethCall(rpc, account, encodeFunctionData({ abi: accountAbi, functionName: "guardianRoot" })), rootBefore)) fail("guardian root was not rotated");
  ok("validator set replaced and the guardian root rotated");

  const opNonce = await accountNonce(rpc, entryPoint, account);
  const probeCall = encodeAbiParameters([{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }], [[account, 0n, "0x"]]);
  const newOp = await signOp(rpc, {
    sender: account, nonce: opNonce,
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, probeCall] }),
    entryPoint, validator: newValidator, key: newKey
  });
  const receipt = await send(rpc, DEPLOYER_ADDRESS, entryPoint, encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(newOp)], DEPLOYER_ADDRESS] }), "0x7a1200");
  const success = receipt.logs.some(l => l.topics[0]?.toLowerCase() === "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"
    && BigInt(`0x${l.data.slice(66, 130)}`) === 1n);
  if (!success) fail("the new key could not drive the recovered account");
  ok(`account ${account} operated by the new passkey — same address`);

  console.log("\nIntent board passed: one published approval, one private, finalised by a stranger.");
}

main()
  .catch(error => { if (!process.exitCode) process.exitCode = 1; console.error(error?.stack ?? error); })
  .finally(() => { if (anvil) anvil.kill(); });
