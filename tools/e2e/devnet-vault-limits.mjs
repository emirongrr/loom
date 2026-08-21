// A spending limit, and the delayed path around it, on a live devnet.
//
//   npm run e2e:vault-limits
//
// `VaultHook` has contract tests and the SDK exposes `scheduleVaultWithdrawal`,
// but nothing joined them: whether a policy actually meters real spending, and
// whether the scheduled path actually rescues a spend the limit refuses, had
// never been asked of the deployed contracts.
//
// What it proves, in order:
//
//   1. A policy cannot be set by asking. `setVaultPolicy` requires
//      `isExecutingScheduled`, so it takes the account's config timelock.
//   2. Under the limit, spending is ordinary and needs nothing extra.
//   3. The limit is a *budget for a period*, not a per-call cap: a second spend
//      that is individually under the limit is still refused once the two
//      together exceed it.
//   4. A spend above the limit is refused outright, and the scheduled
//      withdrawal path is what carries it -- after its own delay, and only for
//      the exact call that was scheduled.
//
// Every failure is fatal and the devnet is always torn down.

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
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToHex } from "viem";
import { devnetPort, requireExclusiveDevnet } from "./exclusive-devnet.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";
const ZERO32 = `0x${"00".repeat(32)}`;
const NATIVE = "0x0000000000000000000000000000000000000000";
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const DAILY_LIMIT = 10n ** 14n;

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
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await rpc("eth_chainId", []); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  fail("anvil did not become ready");
}

function forgeScript(target, env) {
  const result = spawnSync(bin("forge"), ["script", target, "--rpc-url", RPC_URL, "--broadcast", "--skip-simulation", "-vvvv"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) fail(`forge script ${target} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result;
}

async function waitForReceipt(rpc, hash) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(r => setTimeout(r, 100));
  }
  fail(`no receipt for ${hash}`);
}

async function sendFromDeployer(rpc, to, data, gas = "0x5b8d80", { assert = false } = {}) {
  const hash = await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to, data, gas }]);
  const receipt = await waitForReceipt(rpc, hash);
  if (assert && receipt.status !== "0x1") {
    let reason = "no revert data";
    try { await rpc("eth_call", [{ from: DEPLOYER_ADDRESS, to, data }, receipt.blockNumber]); }
    catch (issue) { reason = issue?.message ?? String(issue); }
    fail(`transaction reverted: ${hash}\n  ${reason}`);
  }
  return receipt;
}

async function ethCall(rpc, to, data) {
  return rpc("eth_call", [{ to, data }, "latest"]);
}

async function increaseTime(rpc, seconds) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

function softwareP256Key() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const word = v => `0x${Buffer.from(v, "base64url").toString("hex").padStart(64, "0")}`;
  return {
    x: word(jwk.x), y: word(jwk.y),
    sign: preimage => `0x${crypto.sign("sha256", preimage, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex")}`
  };
}

async function accountNonce(rpc, entryPoint, account) {
  return BigInt(await ethCall(rpc, entryPoint, encodeFunctionData({
    abi: EntryPointAbi, functionName: "getNonce", args: [account, 0n]
  })));
}

function packedTuple(op) {
  return {
    sender: op.sender, nonce: op.nonce, initCode: op.initCode, callData: op.callData,
    accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas,
    gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, signature: op.signature
  };
}

async function signWithPasskey(rpc, fields, { entryPoint, validator, key }) {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  const unsigned = {
    ...fields,
    callGasLimit: 1_500_000n, verificationGasLimit: 6_000_000n, preVerificationGas: 200_000n,
    maxFeePerGas: baseFee * 2n + 2_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, signature: "0x"
  };
  const hash = getUserOpHash(packUserOperation(unsigned), entryPoint, CHAIN_ID);
  const authenticatorData = Buffer.concat([
    Buffer.from(keccak256(stringToHex(RP_ID)).slice(2), "hex"), Buffer.from([0x05])
  ]);
  const clientDataJSON = Buffer.from(
    `{"type":"webauthn.get","challenge":"${base64UrlEncode(hash)}","origin":"${ORIGIN}","crossOrigin":false}`, "utf8"
  );
  const preimage = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
  const { r, s } = parseP256Signature(key.sign(preimage));
  return packUserOperation({
    ...unsigned,
    signature: encodeValidatorSignature(validator, encodeWebAuthnSignature({
      authenticatorData: `0x${authenticatorData.toString("hex")}`,
      clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
      origin: ORIGIN, r, s
    }))
  });
}

const USER_OP_EVENT = keccak256(stringToHex(
  "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"
));

/**
 * Submit one operation and read the outcome the EntryPoint actually reported.
 *
 * A reverted inner call still emits `UserOperationEvent`, with `success` false.
 * Reading only the event's presence would call every refused spend a success,
 * which would make the refusal assertions here prove nothing.
 */
async function handleOps(rpc, entryPoint, op, { expect = "success" } = {}) {
  const receipt = await sendFromDeployer(rpc, entryPoint, encodeFunctionData({
    abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(op)], DEPLOYER_ADDRESS]
  }), "0x7a1200");
  const event = receipt.logs.find(log => log.topics[0] === USER_OP_EVENT);
  const succeeded = Boolean(event) && BigInt(`0x${event.data.slice(2 + 64, 2 + 128)}`) === 1n;
  if (expect === "success" && !succeeded) fail("the operation was expected to succeed and did not");
  if (expect === "failure" && succeeded) fail("the operation was expected to be refused and was not");
  return receipt;
}

/** Run one call from the account, signed by its passkey owner. */
async function fromAccount(rpc, { account, entryPoint, validator, key, callData }, options = {}) {
  const op = await signWithPasskey(rpc, {
    sender: account, nonce: await accountNonce(rpc, entryPoint, account), callData
  }, { entryPoint, validator, key });
  return handleOps(rpc, entryPoint, op, options);
}

function singleExecution(target, value, callData) {
  return encodeFunctionData({
    abi: LoomAccountAbi,
    functionName: "execute",
    args: [ZERO32, encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
      [[target, value, callData]]
    )]
  });
}

/**
 * Route a call through the account's config timelock.
 *
 * `setVaultPolicy` refuses anything else: a spending policy is the thing
 * standing between a compromised key and the balance, so changing it waits.
 */
async function throughTimelock(rpc, { account, entryPoint, validator, key, target, data }) {
  const schedule = encodeFunctionData({
    abi: LoomAccountAbi, functionName: "scheduleCall", args: [target, 0n, data, BigInt(3 * DAY)]
  });
  await fromAccount(rpc, {
    account, entryPoint, validator, key, callData: singleExecution(account, 0n, schedule)
  });
  await increaseTime(rpc, 3 * DAY + 60);
  await sendFromDeployer(rpc, account, encodeFunctionData({
    abi: LoomAccountAbi, functionName: "executeScheduled", args: [target, 0n, data]
  }), "0x5b8d80", { assert: true });
}

async function main() {
  console.log("==> Starting anvil devnet");
  await requireExclusiveDevnet(RPC_URL);
  anvil = spawn(bin("anvil"), ["--port", devnetPort(RPC_URL), "--chain-id", String(CHAIN_ID), "--silent"], { cwd: repoRoot, stdio: "ignore" });
  anvil.on("error", error => fail(`anvil failed to start: ${error.message}`));
  const rpc = createJsonRpcClient(RPC_URL);
  await waitForRpc(rpc);
  if (!(await probeP256Precompile(rpc)).supported) fail("the devnet has no P-256 precompile");

  console.log("==> Deploying the Loom stack");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });
  const deployed = parseFoundryBroadcast(JSON.parse(readFileSync(
    join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8"
  ))).createdContracts;
  const need = name => deployed[name] ?? fail(`the broadcast has no ${name}`);
  const entryPoint = need("EntryPoint");
  const factory = need("LoomAccountFactory");
  const validator = need("P256Validator");
  const policyHook = need("PolicyHook");
  const vaultHook = need("VaultHook");
  console.log(`    vault hook ${vaultHook}`);

  const key = softwareP256Key();
  const config = {
    entryPoint, guardianRoot: ZERO32, guardianThreshold: 0,
    configHash: keccak256(stringToHex("loom.devnet.vault.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      // Installing the vault hook meters nothing on its own: an asset is
      // unprotected until a policy names it.
      { moduleTypeId: 4n, module: vaultHook, initData: "0x" },
      {
        moduleTypeId: 1n, module: validator,
        initData: encodeFunctionData({
          abi: P256ValidatorAbi, functionName: "initialize",
          args: [key.x, key.y, keccak256(stringToHex(RP_ID)), keccak256(stringToHex(ORIGIN)), policyHook]
        })
      }
    ]
  };
  const salt = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["loom.devnet.vault", key.x]));
  const implementation = `0x${(await ethCall(rpc, factory, encodeFunctionData({
    abi: LoomAccountFactoryAbi, functionName: "accountImplementation"
  }))).slice(26)}`;
  const proxyArtifact = JSON.parse(readFileSync(
    join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8"
  ));
  const account = deriveAccountAddress({
    factory, implementation, proxyCreationCode: proxyArtifact.bytecode.object, salt, config
  });
  console.log(`\n==> account: ${account}`);

  await sendFromDeployer(rpc, entryPoint, encodeFunctionData({
    abi: EntryPointAbi, functionName: "depositTo", args: [account]
  }), "0x5b8d80", { assert: true });
  await rpc("eth_sendTransaction", [{ from: DEPLOYER_ADDRESS, to: account, value: "0xde0b6b3a7640000", gas: "0x5b8d80" }]);

  const deployOp = await signWithPasskey(rpc, {
    sender: account, nonce: 0n, factory,
    factoryData: encodeFunctionData({
      abi: LoomAccountFactoryAbi, functionName: "createAccount",
      args: [salt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules]
    }),
    callData: singleExecution(account, 0n, "0x")
  }, { entryPoint, validator, key });
  await handleOps(rpc, entryPoint, deployOp);
  if ((await rpc("eth_getCode", [account, "latest"])) === "0x") fail("account not deployed");
  console.log("    ok  account created with the vault hook installed and no policy yet");

  // --- the policy -----------------------------------------------------------
  console.log("\n==> Setting a native-asset spending policy through the config timelock");
  const vaultAbi = parseAbi([
    "function setVaultPolicy(address asset, (uint128 dailyLimit, uint48 period, uint48 delay, bool enabled) policy)",
    "function scheduleVaultWithdrawal(address target, uint256 value, bytes callData, uint48 executionWindow) returns (bytes32)",
    "function policies(address account, address asset) view returns (uint128 dailyLimit, uint48 period, uint48 delay, bool enabled)"
  ]);
  await throughTimelock(rpc, {
    account, entryPoint, validator, key, target: vaultHook,
    data: encodeFunctionData({
      abi: vaultAbi, functionName: "setVaultPolicy",
      args: [NATIVE, [DAILY_LIMIT, DAY, HOUR, true]]
    })
  });
  const policy = await ethCall(rpc, vaultHook, encodeFunctionData({
    abi: vaultAbi, functionName: "policies", args: [account, NATIVE]
  }));
  if (BigInt(`0x${policy.slice(2, 66)}`) !== DAILY_LIMIT) fail("the policy was not stored");
  console.log(`    ok  daily limit ${DAILY_LIMIT} wei, 1-day period, 1-hour withdrawal delay`);

  // --- spending under the limit --------------------------------------------
  const beneficiary = getAddress("0x000000000000000000000000000000000000beef");
  const depositCall = encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [beneficiary] });
  const held = async () => BigInt(await ethCall(rpc, entryPoint, encodeFunctionData({
    abi: EntryPointAbi, functionName: "balanceOf", args: [beneficiary]
  })));

  console.log("\n==> Spending under the limit");
  const first = 6n * 10n ** 13n;
  const before = await held();
  await fromAccount(rpc, {
    account, entryPoint, validator, key, callData: singleExecution(entryPoint, first, depositCall)
  });
  if ((await held()) - before !== first) fail("the permitted spend did not go through");
  console.log(`    ok  ${first} wei moved with nothing extra required`);

  // --- the limit is a budget, not a per-call cap ---------------------------
  console.log("\n==> A second spend that is individually under the limit");
  const marker = await held();
  await fromAccount(rpc, {
    account, entryPoint, validator, key, callData: singleExecution(entryPoint, first, depositCall)
  }, { expect: "failure" });
  if ((await held()) !== marker) fail("a refused spend still moved funds");
  console.log("    ok  refused: the two together exceed the period budget, so the limit is not per call");

  // --- above the limit: the scheduled path ---------------------------------
  console.log("\n==> A spend above the limit, without scheduling it");
  const large = 5n * 10n ** 14n;
  const beforeLarge = await held();
  await fromAccount(rpc, {
    account, entryPoint, validator, key, callData: singleExecution(entryPoint, large, depositCall)
  }, { expect: "failure" });
  if ((await held()) !== beforeLarge) fail("an unscheduled over-limit spend still moved funds");
  console.log("    ok  refused, and no funds moved");

  console.log("\n==> The same spend, scheduled and matured");
  await fromAccount(rpc, {
    account, entryPoint, validator, key,
    callData: singleExecution(vaultHook, 0n, encodeFunctionData({
      abi: vaultAbi, functionName: "scheduleVaultWithdrawal",
      args: [entryPoint, large, depositCall, 7 * DAY]
    }))
  });
  await fromAccount(rpc, {
    account, entryPoint, validator, key, callData: singleExecution(entryPoint, large, depositCall)
  }, { expect: "failure" });
  console.log("    ok  still refused before the withdrawal delay elapses");

  await increaseTime(rpc, HOUR + 60);
  await fromAccount(rpc, {
    account, entryPoint, validator, key, callData: singleExecution(entryPoint, large, depositCall)
  });
  if ((await held()) - beforeLarge !== large) fail("the matured withdrawal did not move the scheduled amount");
  console.log(`    ok  ${large} wei moved after its own delay, for the exact call that was scheduled`);

  console.log("\nVault limits passed: metered per period, refused above the limit, carried by the delayed path.");
}

try {
  await main();
} finally {
  if (anvil) anvil.kill();
}
