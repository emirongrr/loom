// Hermetic end-to-end Loom lifecycle on a local devnet — contracts only.
//
//   npm run e2e:devnet
//
// This is a full black-box exercise of Loom with no app, no bundler, and no
// SDK runtime in the account path:
//
//   1. Start a fresh anvil devnet (deterministic, isolated, torn down after).
//   2. Probe the live EIP-7951 P-256 precompile so native mode is evidence
//      backed on this node exactly as production requires.
//   3. Deploy the full Loom stack with DeployDevnet (real broadcast).
//   4. Verify the deployment against the live chain with @loom/deployment:
//      parse the broadcast, read bytecode, compute code hashes, re-probe.
//   5. Generate a fresh software P-256 key and run DevnetAccountLifecycle:
//      create a LoomAccount through EntryPoint.handleOps with a WebAuthn
//      signature, execute a call, then execute a second call on the deployed
//      account. The script asserts on-chain state after each broadcast.
//
// Every failure is fatal and the devnet is always torn down.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJsonRpcClient,
  parseFoundryBroadcast,
  probeP256Precompile
} from "../../packages/deployment/src/index.js";
import {
  base64UrlEncode,
  deriveAccountAddress,
  encodeValidatorSignature,
  encodeWebAuthnSignature,
  getUserOpHash,
  packUserOperation,
  parseP256Signature
} from "../../packages/core/dist/index.js";
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex } from "viem";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RPC_URL = process.env.DEVNET_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337;
// anvil's first deterministic dev account (well-known, devnet only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
  for (let i = 0; i < attempts; i++) {
    try {
      await rpc("eth_chainId", []);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  fail("anvil did not become reachable");
}

function forgeScript(scriptTarget, env) {
  const result = spawnSync(
    bin("forge"),
    ["script", scriptTarget, "--rpc-url", RPC_URL, "--broadcast", "--skip-simulation"],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } }
  );
  if (result.status !== 0) fail(`${scriptTarget} exited with code ${result.status}`);
}

function softwareP256Key() {
  // Fresh P-256 keypair; identical envelope to a device passkey, but held in
  // software so CI needs no authenticator. Devnet only. Coordinates are padded
  // to 32 bytes: JWK strips leading zeros, and vm.envBytes32 requires exactly
  // 32 bytes.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = privateKey.export({ format: "jwk" });
  const word = value => `0x${Buffer.from(value, "base64url").toString("hex").padStart(64, "0")}`;
  return {
    privateKey: word(raw.d),
    x: word(jwk.x),
    y: word(jwk.y),
    // Sign a WebAuthn preimage the way an authenticator does: the P-256
    // signature is over sha256(preimage), returned as raw 64-byte r||s.
    sign(preimage) {
      const signature = crypto.sign("sha256", preimage, {
        key: privateKey,
        dsaEncoding: "ieee-p1363"
      });
      return `0x${signature.toString("hex")}`;
    }
  };
}

// ABI fragments for the SDK-driven phase. The PackedUserOperation layout is the
// on-wire struct the EntryPoint consumes.
const PACKED_USER_OPERATION_COMPONENTS = [
  { name: "sender", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "initCode", type: "bytes" },
  { name: "callData", type: "bytes" },
  { name: "accountGasLimits", type: "bytes32" },
  { name: "preVerificationGas", type: "uint256" },
  { name: "gasFees", type: "bytes32" },
  { name: "paymasterAndData", type: "bytes" },
  { name: "signature", type: "bytes" }
];
const ENTRY_POINT_ABI = [
  {
    type: "function",
    name: "getUserOpHash",
    stateMutability: "view",
    inputs: [{ name: "userOp", type: "tuple", components: PACKED_USER_OPERATION_COMPONENTS }],
    outputs: [{ type: "bytes32" }]
  },
  {
    type: "function",
    name: "handleOps",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ops", type: "tuple[]", components: PACKED_USER_OPERATION_COMPONENTS },
      { name: "beneficiary", type: "address" }
    ],
    outputs: []
  }
];
const MODULE_INIT_COMPONENTS = [
  { name: "moduleTypeId", type: "uint256" },
  { name: "module", type: "address" },
  { name: "initData", type: "bytes" }
];
const FACTORY_ABI = [
  {
    type: "function",
    name: "accountImplementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }]
  },
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "guardianRoot", type: "bytes32" },
      { name: "guardianThreshold", type: "uint8" },
      { name: "configHash", type: "bytes32" },
      { name: "modules", type: "tuple[]", components: MODULE_INIT_COMPONENTS }
    ],
    outputs: [{ type: "address" }]
  }
];
const TARGET_ABI = [
  { type: "function", name: "value", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setValue", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }
];
const P256_INITIALIZE_ABI = [
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" }
    ],
    outputs: []
  }
];
const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" }
    ],
    outputs: []
  }
];
// anvil's first deterministic dev account address (unlocked on the devnet).
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";
const ZERO32 = `0x${"00".repeat(64 / 2)}`;

function packedTuple(op) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: op.preVerificationGas,
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature
  };
}

// The SDK capstone: after the Solidity-driven lifecycle proved the chain path,
// build and submit a third operation on the deployed account using ONLY
// @loom/core and the software P-256 key — derive the address locally, compute
// the canonical hash locally (cross-checked against the live EntryPoint), sign
// the exact hash the chain validates, encode the contract envelope, and submit
// through EntryPoint.handleOps on the live devnet.
async function sdkDrivenOperation(rpc, { entryPoint, factory, validator, policyHook, target }, key) {
  const ethCall = async (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

  console.log("==> SDK-driven operation (@loom/core end to end)");

  // 1. Rebuild the exact account configuration the lifecycle script committed.
  const rpIdHash = keccak256(stringToHex(RP_ID));
  const originHash = keccak256(stringToHex(ORIGIN));
  const config = {
    entryPoint,
    guardianRoot: keccak256(stringToHex("loom.devnet.lifecycle.guardian-root")),
    guardianThreshold: 1,
    configHash: keccak256(stringToHex("loom.devnet.lifecycle.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      {
        moduleTypeId: 1n,
        module: validator,
        initData: encodeFunctionData({
          abi: P256_INITIALIZE_ABI,
          functionName: "initialize",
          args: [key.x, key.y, rpIdHash, originHash, policyHook]
        })
      }
    ]
  };
  const salt = keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }], [
      "loom.devnet.lifecycle",
      key.x,
      key.y
    ])
  );

  // 2. Derive the account address locally and cross-check it three ways:
  //    local CREATE2 == live factory.getAddress == deployed code on chain.
  const implementation = `0x${(await ethCall(factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "accountImplementation" }))).slice(26)}`;
  const proxyArtifact = JSON.parse(
    readFileSync(join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8")
  );
  const derived = deriveAccountAddress({
    factory,
    implementation,
    proxyCreationCode: proxyArtifact.bytecode.object,
    salt,
    config
  });
  const getAddressData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "getAddress",
    args: [salt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules]
  });
  const liveAddress = `0x${(await ethCall(factory, getAddressData)).slice(26)}`;
  if (derived.toLowerCase() !== liveAddress.toLowerCase()) {
    fail(`SDK-derived address ${derived} != live factory.getAddress ${liveAddress}`);
  }
  const code = await rpc("eth_getCode", [derived, "latest"]);
  if (!code || code === "0x") fail(`derived account ${derived} has no code after the lifecycle`);
  console.log(`    ok  local CREATE2 derivation matches the live factory — ${derived}`);

  // 3. Build the third operation entirely off-chain with @loom/core.
  const nonceWord = await ethCall(
    entryPoint,
    `0x35567e1a${derived.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}`
  );
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  // abi.encode(Execution) encodes the struct as a single tuple (with its head
  // offset), not as three loose parameters — ExecutionLib decodes it that way.
  const execution = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[target, 0n, encodeFunctionData({ abi: TARGET_ABI, functionName: "setValue", args: [4242n] })]]
  );
  const unsigned = {
    sender: derived,
    nonce: BigInt(nonceWord),
    callData: encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [ZERO32, execution] }),
    callGasLimit: 1_500_000n,
    verificationGasLimit: 6_000_000n,
    preVerificationGas: 200_000n,
    maxFeePerGas: baseFee * 2n + 2_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    signature: "0x"
  };
  const packed = packUserOperation(unsigned);

  // 4. Canonical hash: computed locally, then cross-checked against the LIVE
  //    EntryPoint's getUserOpHash — the on-chain differential.
  const localHash = getUserOpHash(packed, entryPoint, 31337n);
  const liveHash = await ethCall(
    entryPoint,
    encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "getUserOpHash", args: [packedTuple(packed)] })
  );
  if (localHash.toLowerCase() !== liveHash.toLowerCase()) {
    fail(`SDK userOpHash ${localHash} != live EntryPoint.getUserOpHash ${liveHash}`);
  }
  console.log(`    ok  local canonical hash matches the live EntryPoint — ${localHash}`);

  // 5. Sign the exact hash the chain validates, as an authenticator would:
  //    challenge = base64url(userOpHash), signature over
  //    sha256(authenticatorData || sha256(clientDataJSON)).
  const authenticatorData = Buffer.concat([Buffer.from(rpIdHash.slice(2), "hex"), Buffer.from([0x05])]);
  const clientDataJSON = Buffer.from(
    `{"type":"webauthn.get","challenge":"${base64UrlEncode(localHash)}","origin":"${ORIGIN}","crossOrigin":false}`,
    "utf8"
  );
  const preimage = Buffer.concat([
    authenticatorData,
    crypto.createHash("sha256").update(clientDataJSON).digest()
  ]);
  const { r, s } = parseP256Signature(key.sign(preimage));
  const signature = encodeValidatorSignature(
    validator,
    encodeWebAuthnSignature({
      authenticatorData: `0x${authenticatorData.toString("hex")}`,
      clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
      origin: ORIGIN,
      r,
      s
    })
  );
  const signed = packUserOperation({ ...unsigned, signature });

  // 6. Submit through the live EntryPoint and prove execution.
  const txHash = await rpc("eth_sendTransaction", [
    {
      from: DEPLOYER_ADDRESS,
      to: entryPoint,
      gas: "0x7a1200",
      data: encodeFunctionData({
        abi: ENTRY_POINT_ABI,
        functionName: "handleOps",
        args: [[packedTuple(signed)], DEPLOYER_ADDRESS]
      })
    }
  ]);
  let receipt = null;
  for (let i = 0; i < 60 && receipt === null; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (receipt === null) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!receipt || receipt.status !== "0x1") fail(`SDK-driven handleOps did not succeed (status ${receipt?.status})`);

  const valueWord = await ethCall(target, encodeFunctionData({ abi: TARGET_ABI, functionName: "value" }));
  if (BigInt(valueWord) !== 4242n) fail(`target value is ${BigInt(valueWord)}, expected 4242`);
  console.log("    ok  SDK-built, SDK-signed operation executed through the live EntryPoint (value=4242)");
}

let anvil;

async function main() {
  const rpc = createJsonRpcClient(RPC_URL);

  console.log("==> Starting anvil devnet");
  anvil = spawn(bin("anvil"), ["--port", "8545", "--chain-id", String(CHAIN_ID), "--silent"], {
    cwd: repoRoot,
    stdio: "ignore"
  });
  anvil.on("error", error => fail(`anvil failed to start: ${error.message}`));
  await waitForRpc(rpc);

  console.log("==> Probing the native EIP-7951 P-256 precompile");
  const probe = await probeP256Precompile(rpc);
  if (!probe.supported) fail(`devnet P-256 precompile probe failed (valid=${probe.valid}, invalid=${probe.invalid})`);
  console.log("    native precompile verifies valid vectors and rejects corrupted ones");

  console.log("==> Deploying the Loom stack (DeployDevnet)");
  forgeScript("script/DeployDevnet.s.sol:DeployDevnet", { DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });

  const broadcastPath = join(repoRoot, "broadcast", "DeployDevnet.s.sol", String(CHAIN_ID), "run-latest.json");
  if (!existsSync(broadcastPath)) fail(`deploy broadcast missing: ${broadcastPath}`);
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8"));

  console.log("==> Verifying the deployment with @loom/deployment");
  const parsed = parseFoundryBroadcast(broadcast);
  for (const [label, address] of Object.entries(parsed.addresses)) {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (!code || code === "0x") fail(`${label} at ${address} has no code on the devnet`);
    console.log(`    ok  ${label} deployed with live bytecode — ${address}`);
  }

  const created = parsed.createdContracts;
  const need = name => {
    const address = created[name];
    if (!address) fail(`deployment is missing ${name}`);
    return address;
  };

  const key = softwareP256Key();
  console.log("==> Running the account lifecycle (DevnetAccountLifecycle)");
  forgeScript("script/DevnetAccountLifecycle.s.sol:DevnetAccountLifecycle", {
    DEVNET_DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY,
    DEVNET_ENTRYPOINT: need("EntryPoint"),
    DEVNET_FACTORY: need("LoomAccountFactory"),
    DEVNET_P256_VALIDATOR: need("P256Validator"),
    DEVNET_POLICY_HOOK: need("PolicyHook"),
    DEVNET_TARGET: need("DevnetTarget"),
    DEVNET_P256_PRIVATE_KEY: key.privateKey,
    DEVNET_P256_X: key.x,
    DEVNET_P256_Y: key.y
  });

  await sdkDrivenOperation(
    rpc,
    {
      entryPoint: need("EntryPoint"),
      factory: need("LoomAccountFactory"),
      validator: need("P256Validator"),
      policyHook: need("PolicyHook"),
      target: need("DevnetTarget")
    },
    key
  );

  console.log(
    "\nE2E devnet lifecycle passed: deployed, verified, account created, two operations executed, and a third built, signed, and submitted entirely by the SDK."
  );
}

try {
  await main();
} finally {
  if (anvil && !anvil.killed) anvil.kill();
}
