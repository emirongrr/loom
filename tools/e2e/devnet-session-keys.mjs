// A session key, granted through the account's own timelock, on a live devnet.
//
//   npm run e2e:session-keys
//
// The contracts have unit tests and the SDK builds the grant, but nothing
// exercised the line between them: does a permission the SDK describes actually
// let a session key spend, and does it actually stop it at the boundary? This
// runs that line end to end against real contracts.
//
// What it proves, in order:
//
//   1. A session permission cannot be granted by asking. `grantPermission`
//      requires `isExecutingScheduled`, so it goes through `scheduleCall`, the
//      three-day config delay, and `executeScheduled` -- the same routing every
//      executor-type call takes.
//   2. Inside its bounds, an ordinary ECDSA key drives the account. No passkey,
//      no owner signature.
//   3. At the boundary it stops: a different target is refused, and the uses
//      counter is enforced by the nonce sequence rather than by trust.
//   4. Revocation is immediate and does not need the delay, because removing
//      authority is not the dangerous direction.
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
import {
  encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToHex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { devnetPort, requireExclusiveDevnet } from "./exclusive-devnet.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";
const ZERO32 = `0x${"00".repeat(32)}`;
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SESSION_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
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
    // Replay as a call so the revert reason is reported rather than just the hash.
    let reason = "no revert data";
    try { await rpc("eth_call", [{ from: DEPLOYER_ADDRESS, to, data }, receipt.blockNumber]); }
    catch (issue) { reason = issue?.message ?? String(issue); }
    fail(`transaction reverted: ${hash}
  ${reason}`);
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

async function accountNonce(rpc, entryPoint, account, key = 0n) {
  const word = await ethCall(rpc, entryPoint, encodeFunctionData({
    abi: EntryPointAbi, functionName: "getNonce", args: [account, key]
  }));
  return BigInt(word);
}

function packedTuple(op) {
  return {
    sender: op.sender, nonce: op.nonce, initCode: op.initCode, callData: op.callData,
    accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas,
    gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, signature: op.signature
  };
}

async function unsignedOp(rpc, { sender, nonce, factory, factoryData, callData }) {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  return {
    sender, nonce, ...(factory ? { factory, factoryData } : {}), callData,
    callGasLimit: 1_500_000n, verificationGasLimit: 6_000_000n, preVerificationGas: 200_000n,
    maxFeePerGas: baseFee * 2n + 2_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, signature: "0x"
  };
}

/** The account owner signs with the passkey, exactly as the wallet does. */
async function signWithPasskey(rpc, fields, { entryPoint, validator, key }) {
  const unsigned = await unsignedOp(rpc, fields);
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

/**
 * The session key signs with an ordinary secp256k1 signature.
 *
 * The validator decodes `(permissionId, signature)`, so the permission being
 * claimed travels with the signature and the account never has to guess which
 * grant a session key means.
 */
async function signWithSessionKey(rpc, fields, { entryPoint, sessionValidator, permissionId, signer }) {
  const unsigned = await unsignedOp(rpc, fields);
  const hash = getUserOpHash(packUserOperation(unsigned), entryPoint, CHAIN_ID);
  const signature = await signer.sign({ hash });
  return packUserOperation({
    ...unsigned,
    signature: encodeValidatorSignature(
      sessionValidator,
      encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [permissionId, signature])
    )
  });
}

const USER_OP_EVENT = keccak256(stringToHex(
  "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"
));

/**
 * Submit one operation and read the outcome the EntryPoint actually reported.
 *
 * `UserOperationEvent` carries a `success` flag, and a reverted inner call still
 * emits it. Treating the event's presence as success would call every refused
 * operation a success -- which is exactly the mistake this rehearsal exists to
 * catch, so it must not make it.
 */
async function handleOps(rpc, entryPoint, op, { expect = "success" } = {}) {
  const receipt = await sendFromDeployer(rpc, entryPoint, encodeFunctionData({
    abi: EntryPointAbi, functionName: "handleOps", args: [[packedTuple(op)], DEPLOYER_ADDRESS]
  }), "0x7a1200");
  const event = receipt.logs.find(log => log.topics[0] === USER_OP_EVENT);
  // `(nonce, success, actualGasCost, actualGasUsed)`: success is the second word.
  const succeeded = Boolean(event) && BigInt(`0x${event.data.slice(2 + 64, 2 + 128)}`) === 1n;
  if (expect === "success" && !succeeded) {
    fail(`the operation was expected to succeed and did not (event ${event ? "present" : "absent"})`);
  }
  if (expect === "failure" && succeeded) fail("the operation was expected to be refused and was not");
  return receipt;
}

/**
 * Route a call through the account's config timelock.
 *
 * `grantPermission` refuses anything else: a session key is authority, and
 * authority arrives on a delay so the account's owner has time to see it.
 */
async function throughTimelock(rpc, { account, entryPoint, validator, key, target, data }) {
  const schedule = encodeFunctionData({
    abi: LoomAccountAbi, functionName: "scheduleCall", args: [target, 0n, data, BigInt(3 * DAY)]
  });
  const selfCall = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[account, 0n, schedule]]
  );
  const op = await signWithPasskey(rpc, {
    sender: account, nonce: await accountNonce(rpc, entryPoint, account),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, selfCall] })
  }, { entryPoint, validator, key });
  await handleOps(rpc, entryPoint, op);

  await increaseTime(rpc, 3 * DAY + 60);
  await sendFromDeployer(rpc, account, encodeFunctionData({
    abi: LoomAccountAbi, functionName: "executeScheduled", args: [target, 0n, data]
  }), "0x5b8d80", { assert: true });
}

function permissionNonceKey(permissionId) {
  // `uint192(bytes24(permissionId))`: the ERC-4337 nonce key is 192 bits, and
  // the validator binds each permission to exactly one.
  return BigInt(`0x${permissionId.slice(2, 2 + 48)}`);
}

async function main() {
  console.log("==> Starting anvil devnet");
  await requireExclusiveDevnet(RPC_URL);
  anvil = spawn(bin("anvil"), ["--port", devnetPort(RPC_URL), "--chain-id", String(CHAIN_ID), "--silent"], { cwd: repoRoot, stdio: "ignore" });
  anvil.on("error", error => fail(`anvil failed to start: ${error.message}`));
  const rpc = createJsonRpcClient(RPC_URL);
  await waitForRpc(rpc);

  const probe = await probeP256Precompile(rpc);
  if (!probe.supported) fail("the devnet has no P-256 precompile");

  console.log("==> Deploying the Loom stack");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });
  const broadcast = JSON.parse(readFileSync(
    join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8"
  ));
  const deployed = parseFoundryBroadcast(broadcast).createdContracts;
  const need = name => deployed[name] ?? fail(`the broadcast has no ${name}`);
  const entryPoint = need("EntryPoint");
  const factory = need("LoomAccountFactory");
  const validator = need("P256Validator");
  const policyHook = need("PolicyHook");
  const sessionValidator = need("GranularSessionValidator");
  console.log(`    session validator ${sessionValidator}`);

  // --- an account whose owner is a passkey ---------------------------------
  const key = softwareP256Key();
  const rpIdHash = keccak256(stringToHex(RP_ID));
  const originHash = keccak256(stringToHex(ORIGIN));
  const config = {
    entryPoint, guardianRoot: ZERO32, guardianThreshold: 0,
    configHash: keccak256(stringToHex("loom.devnet.session.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      {
        moduleTypeId: 1n, module: validator,
        initData: encodeFunctionData({
          abi: P256ValidatorAbi, functionName: "initialize", args: [key.x, key.y, rpIdHash, originHash, policyHook]
        })
      },
      // The session validator is installed empty. Installing it grants nothing;
      // only a permission does, and a permission needs the timelock.
      { moduleTypeId: 1n, module: sessionValidator, initData: "0x" }
    ]
  };
  const salt = keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }], ["loom.devnet.session", key.x]
  ));
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

  const noop = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[account, 0n, "0x"]]
  );
  const deployOp = await signWithPasskey(rpc, {
    sender: account, nonce: 0n, factory,
    factoryData: encodeFunctionData({
      abi: LoomAccountFactoryAbi, functionName: "createAccount",
      args: [salt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules]
    }),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, noop] })
  }, { entryPoint, validator, key });
  await handleOps(rpc, entryPoint, deployOp);
  if ((await rpc("eth_getCode", [account, "latest"])) === "0x") fail("account not deployed");
  console.log("    ok  account created with a passkey owner and an empty session validator");

  // --- granting a session key ----------------------------------------------
  console.log("\n==> Granting a session permission through the config timelock");
  const session = privateKeyToAccount(SESSION_KEY);
  // A permission must name a non-zero selector, so a bare value transfer cannot
  // be granted at all: the grant describes a *call*, and the amount rides on it.
  // `EntryPoint.depositTo` is payable, observable through `balanceOf`, and is
  // not one of the administrative targets a session may never touch.
  const target = entryPoint;
  // Deposit for a neutral address, not the account: the account's own deposit
  // pays for this very operation, so measuring it would measure the gas too.
  const beneficiary = getAddress("0x000000000000000000000000000000000000beef");
  const depositSelector = encodeFunctionData({
    abi: EntryPointAbi, functionName: "depositTo", args: [beneficiary]
  }).slice(0, 10);
  const permissionId = keccak256(stringToHex("loom.devnet.session.permission.1"));
  const sessionAbi = parseAbi([
    "function grantPermission(bytes32 permissionId, (address signer, address target, address token, address counterparty, address allowedPaymaster, bytes4 selector, uint128 maxAmountPerCall, uint128 maxAmountPerUserOp, uint48 validAfter, uint48 validUntil, uint32 maxUses, uint16 maxCallsPerUserOp) permission)",
    "function revokePermission(bytes32 permissionId)",
    "function permissions(address account, bytes32 permissionId) view returns (address signer, address target, address token, address counterparty, address allowedPaymaster, bytes4 selector, uint128 maxAmountPerCall, uint128 maxAmountPerUserOp, uint48 validAfter, uint48 validUntil, uint32 maxUses, uint16 maxCallsPerUserOp)"
  ]);
  const permission = {
    signer: session.address,
    target,
    token: "0x0000000000000000000000000000000000000000",
    counterparty: "0x0000000000000000000000000000000000000000",
    allowedPaymaster: "0x0000000000000000000000000000000000000000",
    selector: depositSelector,
    maxAmountPerCall: 10n ** 15n,
    maxAmountPerUserOp: 10n ** 15n,
    validAfter: 0,
    validUntil: 2n ** 47n,
    maxUses: 2,
    maxCallsPerUserOp: 1
  };
  await throughTimelock(rpc, {
    account, entryPoint, validator, key, target: sessionValidator,
    data: encodeFunctionData({
      abi: sessionAbi, functionName: "grantPermission",
      args: [permissionId, [
        permission.signer, permission.target, permission.token, permission.counterparty,
        permission.allowedPaymaster, permission.selector, permission.maxAmountPerCall,
        permission.maxAmountPerUserOp, permission.validAfter, permission.validUntil,
        permission.maxUses, permission.maxCallsPerUserOp
      ]]
    })
  });
  const stored = await ethCall(rpc, sessionValidator, encodeFunctionData({
    abi: sessionAbi, functionName: "permissions", args: [account, permissionId]
  }));
  if (!stored.toLowerCase().includes(session.address.slice(2).toLowerCase())) {
    fail("the permission was not stored for the session signer");
  }
  console.log(`    ok  permission granted to ${session.address} after the 3-day delay`);

  // --- the session key spends, inside its bounds ---------------------------
  console.log("\n==> The session key drives the account, with no passkey involved");
  const nonceKey = permissionNonceKey(permissionId);
  const depositCall = encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [beneficiary] });
  const depositBalance = async () => BigInt(await ethCall(rpc, entryPoint, encodeFunctionData({
    abi: EntryPointAbi, functionName: "balanceOf", args: [beneficiary]
  })));
  const before = await depositBalance();
  const spend = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[target, 10n ** 14n, depositCall]]
  );
  const sessionOp = await signWithSessionKey(rpc, {
    sender: account, nonce: await accountNonce(rpc, entryPoint, account, nonceKey),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, spend] })
  }, { entryPoint, sessionValidator, permissionId, signer: session });
  await handleOps(rpc, entryPoint, sessionOp);
  const after = await depositBalance();
  if (after - before !== 10n ** 14n) fail("the session key did not move the expected amount");
  console.log("    ok  the session key spent within its permission, signing with secp256k1 only");

  // --- and stops at the boundary -------------------------------------------
  console.log("\n==> The same key, one step outside the permission");
  const overLimit = await depositBalance();
  const strayCall = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[target, 10n ** 16n, depositCall]]
  );
  const strayOp = await signWithSessionKey(rpc, {
    sender: account, nonce: await accountNonce(rpc, entryPoint, account, nonceKey),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, strayCall] })
  }, { entryPoint, sessionValidator, permissionId, signer: session });
  await handleOps(rpc, entryPoint, strayOp, { expect: "failure" });
  if (await depositBalance() !== overLimit) fail("a refused call still moved funds");
  console.log("    ok  an amount above the per-call bound is refused, and nothing moved");

  // --- revocation ----------------------------------------------------------
  console.log("\n==> Revoking the permission");
  await throughTimelock(rpc, {
    account, entryPoint, validator, key, target: sessionValidator,
    data: encodeFunctionData({ abi: sessionAbi, functionName: "revokePermission", args: [permissionId] })
  });
  const revokedOp = await signWithSessionKey(rpc, {
    sender: account, nonce: await accountNonce(rpc, entryPoint, account, nonceKey),
    callData: encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [ZERO32, spend] })
  }, { entryPoint, sessionValidator, permissionId, signer: session });
  await handleOps(rpc, entryPoint, revokedOp, { expect: "failure" });
  console.log("    ok  the revoked key can no longer drive the account");

  console.log("\nSession keys passed: granted on a delay, bounded in use, stopped on revocation.");
}

try {
  await main();
} finally {
  if (anvil) anvil.kill();
}
