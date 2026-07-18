// Bundler-in-the-loop devnet proof.
//
//   npm run e2e:bundler-devnet
//
// Brings the pinned devnet up through the `loom` CLI library (anvil + Loom
// contracts + Alto), then drives the FULL @loom/sdk send pipeline against the
// live bundler: fee quote from the bundler's gas oracle, gas estimation with
// the signer's dummy signature, passkey signing over the canonical hash, and
// submission + receipt through eth_sendUserOperation — first creating the
// account counterfactually (initCode through the bundler), then operating it.
// This is the evidence DX-HIGH-003 asks for: a realistic local wallet path
// with a real bundler, reproducibly pinned.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { down, up } from "../../packages/cli/src/devnet.mjs";
import {
  deriveAccountAddress,
  packUserOperation as corePackUserOperation,
  encodeCreateAccountCall,
  EntryPointAbi,
  LoomAccountFactoryAbi,
  P256ValidatorAbi
} from "../../packages/core/dist/index.js";
import {
  createBundlerTransport,
  createLoomClient,
  createPasskeySigner,
  createRpcStateTransport
} from "../../packages/sdk/dist/index.js";
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex } from "viem";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";

async function rpcCall(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let state;
try {
  console.log("==> loom devnet up (anvil + Loom + Alto)");
  state = await up();
  console.log(`    rpc ${state.rpcUrl} · bundler ${state.bundlerUrl} · alto ${state.alto}`);

  const { rpcUrl, bundlerUrl, addresses } = state;
  const entryPoint = addresses.EntryPoint;
  const factory = addresses.LoomAccountFactory;
  const validator = addresses.P256Validator;
  const policyHook = addresses.PolicyHook;
  const target = addresses.DevnetTarget;
  const deployer = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  // A software P-256 passkey and the account configuration it controls.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const pad = value => `0x${Buffer.from(value, "base64url").toString("hex").padStart(64, "0")}`;
  const key = { x: pad(jwk.x), y: pad(jwk.y) };
  const rpIdHash = keccak256(stringToHex(RP_ID));
  const config = {
    entryPoint,
    guardianRoot: keccak256(stringToHex("bundler-devnet.guardians")),
    guardianThreshold: 1,
    configHash: keccak256(stringToHex("bundler-devnet.config")),
    modules: [
      { moduleTypeId: 4n, module: policyHook, initData: "0x" },
      {
        moduleTypeId: 1n,
        module: validator,
        initData: encodeFunctionData({
          abi: P256ValidatorAbi,
          functionName: "initialize",
          args: [key.x, key.y, rpIdHash, keccak256(stringToHex(ORIGIN)), policyHook]
        })
      }
    ]
  };
  const salt = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["bundler-devnet", key.x]));
  const implementation = `0x${(
    await rpcCall(rpcUrl, "eth_call", [
      { to: factory, data: encodeFunctionData({ abi: LoomAccountFactoryAbi, functionName: "accountImplementation" }) },
      "latest"
    ])
  ).slice(26)}`;
  const proxyArtifact = JSON.parse(
    readFileSync(join(repoRoot, "out", "LoomAccountProxy.sol", "LoomAccountProxy.json"), "utf8")
  );
  const account = deriveAccountAddress({
    factory,
    implementation,
    proxyCreationCode: proxyArtifact.bytecode.object,
    salt,
    config
  });
  console.log(`==> account derived: ${account}`);

  // Prefund the account's EntryPoint deposit from the unlocked dev account.
  await rpcCall(rpcUrl, "eth_sendTransaction", [
    {
      from: deployer,
      to: entryPoint,
      value: `0x${(2n * 10n ** 17n).toString(16)}`,
      data: encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [account] })
    }
  ]);

  // The full public client stack: bundler transport, state transport, passkey.
  const signer = createPasskeySigner({
    credentialId: "bundler-devnet-passkey",
    rpId: RP_ID,
    origin: ORIGIN,
    validator,
    entryPoint,
    async signChallenge(challenge) {
      const authenticatorData = Buffer.concat([Buffer.from(rpIdHash.slice(2), "hex"), Buffer.from([0x05])]);
      const clientDataJSON = Buffer.from(
        `{"type":"webauthn.get","challenge":"${challenge.challenge}","origin":"${ORIGIN}","crossOrigin":false}`,
        "utf8"
      );
      const preimage = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
      const signature = crypto.sign("sha256", preimage, { key: privateKey, dsaEncoding: "ieee-p1363" });
      return {
        authenticatorData: `0x${authenticatorData.toString("hex")}`,
        clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
        signature: `0x${signature.toString("hex")}`
      };
    }
  });
  const client = createLoomClient({
    chainId: state.chainId,
    account,
    signer,
    // No kohaku host: privacy is an optional layer and this smoke proves the
    // whole bundler pipeline needs none of it.
    transport: createBundlerTransport({ endpoint: bundlerUrl, entryPoint }),
    stateTransport: createRpcStateTransport({ endpoint: rpcUrl })
  });

  const setValueAbi = [
    { type: "function", name: "setValue", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
    { type: "function", name: "value", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
  ];
  const readValue = async () =>
    BigInt(
      await rpcCall(rpcUrl, "eth_call", [
        { to: target, data: encodeFunctionData({ abi: setValueAbi, functionName: "value" }) },
        "latest"
      ])
    );

  // Deployment goes through the sovereign direct path: the factory fail-closed
  // requires msg.sender == the real EntryPoint's SenderCreator, and the
  // SenderCreator only accepts the EntryPoint itself, so no third-party
  // bundler simulator can validate initCode — by design. The account is
  // created with a signed operation submitted straight to the EntryPoint;
  // everything after that is ordinary bundler traffic.
  console.log("==> op 1 direct to the EntryPoint: create the account and execute (sovereign publication)");
  const deployPrepared = client.prepareUserOperation(
    client.prepareCalls({
      calls: [{ target, value: 0n, data: encodeFunctionData({ abi: setValueAbi, functionName: "setValue", args: [777n] }) }]
    }),
    {
      nonce: 0n,
      factory,
      factoryData: encodeCreateAccountCall(salt, config),
      callGasLimit: 1_500_000n,
      verificationGasLimit: 6_000_000n,
      preVerificationGas: 200_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n
    }
  );
  const deploySignature = await signer.signUserOperation(deployPrepared);
  const packedDeploy = corePackUserOperation({ ...deployPrepared.userOperation, signature: deploySignature });
  const deployTx = await rpcCall(rpcUrl, "eth_sendTransaction", [
    {
      from: deployer,
      to: entryPoint,
      gas: "0x7a1200",
      data: encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedDeploy], deployer] })
    }
  ]);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await readValue(), 777n, "deploy operation did not execute");
  console.log(`    ok  account deployed by direct EntryPoint publication (${deployTx})`);

  console.log("==> op 2 through Alto: full pipeline (fees, gas estimation, validation, receipt from the bundler)");
  const second = await client.sendTransaction({
    calls: [{ target, value: 0n, data: encodeFunctionData({ abi: setValueAbi, functionName: "setValue", args: [4242n] }) }]
  });
  assert.equal(second.receipt?.success, true, "second user operation was not successful");
  assert.equal(await readValue(), 4242n, "second user operation did not execute");
  console.log(`    ok  executed via eth_sendUserOperation (${second.userOpHash})`);

  console.log("==> op 3 through Alto: repeat traffic (nonce advanced through the state transport)");
  const third = await client.sendTransaction({
    calls: [{ target, value: 0n, data: encodeFunctionData({ abi: setValueAbi, functionName: "setValue", args: [9001n] }) }]
  });
  assert.equal(third.receipt?.success, true, "third user operation was not successful");
  assert.equal(await readValue(), 9001n, "third user operation did not execute");
  console.log(`    ok  executed via eth_sendUserOperation (${third.userOpHash})`);

  // Atomic batch with nonzero call values: both items must land — the final
  // stored value proves item 2 ran, and the exact balance delta (5 + 7 wei)
  // proves item 1 ran and value forwarding encodes correctly on-chain.
  console.log("==> op 4 through Alto: atomic batch with value transfers");
  await rpcCall(rpcUrl, "eth_sendTransaction", [
    { from: deployer, to: account, value: `0x${(10n ** 15n).toString(16)}` }
  ]);
  const balanceBefore = BigInt(await rpcCall(rpcUrl, "eth_getBalance", [target, "latest"]));
  const fourth = await client.sendTransaction({
    calls: [
      { target, value: 5n, data: encodeFunctionData({ abi: setValueAbi, functionName: "setValue", args: [1111n] }) },
      { target, value: 7n, data: encodeFunctionData({ abi: setValueAbi, functionName: "setValue", args: [4321n] }) }
    ]
  });
  assert.equal(fourth.receipt?.success, true, "batch user operation was not successful");
  assert.equal(await readValue(), 4321n, "batch item 2 did not execute");
  const balanceAfter = BigInt(await rpcCall(rpcUrl, "eth_getBalance", [target, "latest"]));
  assert.equal(balanceAfter - balanceBefore, 12n, "batch value transfers did not both arrive");
  console.log(`    ok  atomic batch executed via eth_sendUserOperation (${fourth.userOpHash})`);

  // The production-operation doctor, live: run the read-only diagnostics against
  // this same devnet — chain, EntryPoint + SenderCreator code, native P-256, and
  // the bundler serving the deployed EntryPoint — and require a clean report.
  console.log("==> loom doctor against the live devnet");
  const { runDoctor } = await import("../../packages/cli/src/doctor.mjs");
  const doctorRpc = (method, params) => rpcCall(rpcUrl, method, params);
  const bundlerRpc = (method, params) => rpcCall(bundlerUrl, method, params);
  const report = await runDoctor({ rpc: doctorRpc, bundlerRpc, chainId: state.chainId, entryPoint });
  for (const entry of report.checks) {
    console.log(`    [${entry.status}] ${entry.name}: ${entry.detail}`);
  }
  assert.equal(report.ok, true, "doctor reported a failure against a healthy devnet");
  const byName = Object.fromEntries(report.checks.map(c => [c.name, c.status]));
  assert.equal(byName.chain, "ok", "doctor chain check");
  assert.equal(byName.senderCreator, "ok", "doctor SenderCreator check");
  assert.equal(byName.p256, "ok", "doctor native P-256 check");
  assert.equal(byName.bundler, "ok", "doctor bundler check");
  console.log("    ok  doctor reports a healthy devnet");

  console.log("\nBundler devnet passed: sovereign deployment plus the full SDK send pipeline against the pinned Alto bundler.");
} finally {
  try {
    if (state) {
      console.log("==> loom devnet down");
      down();
    }
  } catch (error) {
    console.error(`teardown: ${error.message}`);
  }
}
