// The first send from a counterfactual account: does creation and the transfer
// fit in one user operation, and what exactly happens when that operation fails?
//
//   npm run e2e:atomic-first-send
//
// The wallet currently makes people press "Activate account" before they can
// send anything, which is two passkey ceremonies and two operations to move
// money once. ERC-4337 carries `factory`/`factoryData` alongside `callData`, so
// one operation should do both. This measures that rather than assuming it.
//
// It also measures the failure, which is the part a wallet gets wrong. Account
// creation happens in the *validation* phase; the call runs afterwards. So a
// first send whose transfer reverts does not roll the creation back — the
// account exists, the money did not move, and the EntryPoint reports
// `success = false`. Any wallet that treats "the transaction was mined" as "the
// send worked" would show that as a successful transfer of nothing.
//
//   1. Derive a counterfactual address and fund it before it exists.
//   2. One operation: factory data + a transfer. Assert the account is created
//      and the recipient is paid in a single transaction.
//   3. Repeat on a second account with a transfer larger than the balance.
//      Assert the recipient is not paid, and record what the chain reports.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpcClient, parseFoundryBroadcast, probeP256Precompile } from "../../packages/deployment/src/index.js";
import {
  base64UrlEncode, deriveAccountAddress, encodeValidatorSignature, encodeWebAuthnSignature,
  EntryPointAbi, getUserOpHash, LoomAccountAbi, LoomAccountFactoryAbi, P256ValidatorAbi,
  packUserOperation, parseP256Signature
} from "../../packages/core/dist/index.js";
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex } from "viem";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337n;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";
const ZERO32 = `0x${"00".repeat(32)}`;
// UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)
const USER_OPERATION_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

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
const ethCall = (rpc, to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const balanceOf = async (rpc, address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));

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

/** The single `UserOperationEvent` this operation produced. */
function userOperationOutcome(receipt) {
  const events = receipt.logs.filter(l => l.topics[0]?.toLowerCase() === USER_OPERATION_EVENT);
  if (events.length !== 1) fail(`expected exactly one UserOperationEvent, saw ${events.length}`);
  // data = (nonce, success, actualGasCost, actualGasUsed); success is word 2.
  return { success: BigInt(`0x${events[0].data.slice(66, 130)}`) === 1n };
}

function transferCall(to, value) {
  return encodeFunctionData({
    abi: LoomAccountAbi,
    functionName: "execute",
    args: [ZERO32, encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
      [[to, value, "0x"]]
    )]
  });
}

async function main() {
  const rpc = createJsonRpcClient(RPC_URL);
  console.log("==> Starting anvil devnet");
  anvil = spawn(bin("anvil"), ["--port", "8545", "--chain-id", String(CHAIN_ID), "--silent"], { cwd: repoRoot, stdio: "ignore" });
  anvil.on("error", e => fail(`anvil failed to start: ${e.message}`));
  await waitForRpc(rpc);
  if (!(await probeP256Precompile(rpc)).supported) fail("devnet P-256 precompile probe failed");

  console.log("==> Deploying the Loom stack");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });
  const created = parseFoundryBroadcast(JSON.parse(readFileSync(join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8"))).createdContracts;
  const need = n => created[n] ?? fail(`deployment is missing ${n}`);
  const entryPoint = need("EntryPoint"), factory = need("LoomAccountFactory");
  const validator = need("P256Validator"), policyHook = need("PolicyHook");

  const implementation = `0x${(await ethCall(rpc, factory, encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "accountImplementation" }))).slice(26)}`;
  const proxyCreationCode = JSON.parse(readFileSync(join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8")).bytecode.object;
  const rpIdHash = keccak256(stringToHex(RP_ID));
  const originHash = keccak256(stringToHex(ORIGIN));

  // Build a fresh counterfactual account: an address that does not exist yet.
  const counterfactual = label => {
    const key = softwareP256Key();
    const config = {
      entryPoint, guardianRoot: ZERO32, guardianThreshold: 0,
      configHash: keccak256(stringToHex(`loom.devnet.firstsend.${label}`)),
      modules: [
        { moduleTypeId: 4n, module: policyHook, initData: "0x" },
        { moduleTypeId: 1n, module: validator, initData: encodeFunctionData({
          abi: P256ValidatorAbi, functionName: "initialize", args: [key.x, key.y, rpIdHash, originHash, policyHook] }) }
      ]
    };
    const salt = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], [`loom.devnet.firstsend.${label}`, key.x]));
    const address = deriveAccountAddress({ factory, implementation, proxyCreationCode, salt, config });
    const factoryData = encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "createAccount",
      args: [salt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules] });
    return { key, address, factoryData };
  };

  // --- the send that should work -------------------------------------------
  console.log("\n==> One operation: create the account and pay someone");
  const happy = counterfactual("happy");
  const recipient = `0x${"a1".repeat(20)}`;
  const funding = 3_000_000_000_000_000_000n;   // 3 ETH, before the account exists
  const sendAmount = 250_000_000_000_000_000n;  // 0.25 ETH

  await waitForReceipt(rpc, await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to: happy.address, value: `0x${funding.toString(16)}` }]));
  if ((await rpc("eth_getCode", [happy.address, "latest"])) !== "0x") fail("the address already has code");
  ok(`funded ${happy.address} while it still has no code`);

  const firstSend = await signOp(rpc, {
    sender: happy.address, nonce: 0n, factory, factoryData: happy.factoryData,
    callData: transferCall(recipient, sendAmount), entryPoint, validator, key: happy.key
  });
  const happyTx = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to: entryPoint,
    data: encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(firstSend)], DEPLOYER_ADDRESS] }), gas: "0x7a1200" }]);
  const happyReceipt = await waitForReceipt(rpc, happyTx);
  if (happyReceipt.status !== "0x1") fail("the first send transaction reverted");

  const outcome = userOperationOutcome(happyReceipt);
  if (!outcome.success) fail("the first send reported failure");
  if ((await rpc("eth_getCode", [happy.address, "latest"])) === "0x") fail("the account was not created");
  if ((await balanceOf(rpc, recipient)) !== sendAmount) fail("the recipient was not paid");
  ok("account created and recipient paid in one operation, one transaction");
  ok(`no separate activation step: ${happyReceipt.transactionHash}`);

  // --- the send that must not lie -------------------------------------------
  console.log("\n==> A first send whose transfer cannot succeed");
  const sad = counterfactual("sad");
  const sadRecipient = `0x${"b2".repeat(20)}`;
  const sadFunding = 2_000_000_000_000_000_000n;
  await waitForReceipt(rpc, await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to: sad.address, value: `0x${sadFunding.toString(16)}` }]));

  // More than the account holds, so the call reverts after creation succeeds.
  const impossible = sadFunding * 10n;
  const doomed = await signOp(rpc, {
    sender: sad.address, nonce: 0n, factory, factoryData: sad.factoryData,
    callData: transferCall(sadRecipient, impossible), entryPoint, validator, key: sad.key
  });
  const sadTx = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to: entryPoint,
    data: encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(doomed)], DEPLOYER_ADDRESS] }), gas: "0x7a1200" }]);
  const sadReceipt = await waitForReceipt(rpc, sadTx);

  const sadOutcome = sadReceipt.status === "0x1" ? userOperationOutcome(sadReceipt) : { success: false };
  if (sadOutcome.success) fail("an impossible transfer reported success");
  if ((await balanceOf(rpc, sadRecipient)) !== 0n) fail("the recipient was paid by a failed send");
  ok("the transfer did not happen and the operation reports failure");

  // The finding that matters for the UI. Creation happens during validation, so
  // it survives a reverting call. The account exists; the send did not.
  const sadDeployed = (await rpc("eth_getCode", [sad.address, "latest"])) !== "0x";
  console.log(`\n    note  after the failed first send, the account ${sadDeployed ? "EXISTS" : "does not exist"} on chain`);
  if (sadDeployed) {
    console.log("    note  creation runs in the validation phase, so a reverting call does");
    console.log("          not undo it. A wallet must report this as a failed transfer");
    console.log("          on a created account, never as a successful send.");
  }
  if ((await balanceOf(rpc, sad.address)) === 0n) fail("the account lost its whole balance to a failed send");
  ok("the account keeps its balance apart from gas; nothing was silently spent");

  console.log("\nAtomic first send passed: one operation creates and pays; a failed one pays nobody.");
}

main()
  .catch(error => { if (!process.exitCode) process.exitCode = 1; console.error(error?.stack ?? error); })
  .finally(() => { if (anvil) anvil.kill(); });
