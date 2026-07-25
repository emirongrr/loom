// Minimal Loom account — the clean-room example.
//
// This script runs inside an EMPTY project that installed @loom/core and
// @loom/sdk from packed tarballs (plus viem and node builtins). It never
// imports repository paths: everything it does, an external developer can do.
//
//   1. Generate a software P-256 passkey.
//   2. Derive the counterfactual account address locally with @loom/core and
//      cross-check it against the live factory.
//   3. Build the first user operation (deploy + call) with @loom/sdk, sign its
//      canonical EntryPoint hash through createPasskeySigner, and submit it
//      through the live EntryPoint.
//   4. Send a second operation on the now-deployed account, reading the nonce
//      through the public state transport.
//
// The devnet (anvil + deployed Loom stack) is supplied by the runner via env;
// the example itself only speaks JSON-RPC to it.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  base64UrlEncode,
  deriveAccountAddress,
  encodeCreateAccountCall,
  EntryPointAbi,
  getUserOpHash,
  LoomAccountAbi,
  LoomAccountFactoryAbi,
  P256ValidatorAbi,
  packUserOperation
} from "@loom/core";
import {
  createPasskeySigner,
  createRpcStateTransport,
  fetchEntryPointNonce,
  prepareUserOperationEnvelope
} from "@loom/sdk";
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex } from "viem";

const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
};
const RPC_URL = env("LOOM_RPC_URL");
const entryPoint = env("LOOM_ENTRYPOINT");
const factory = env("LOOM_FACTORY");
const validator = env("LOOM_P256_VALIDATOR");
const policyHook = env("LOOM_POLICY_HOOK");
const target = env("LOOM_TARGET");
const implementation = env("LOOM_IMPLEMENTATION");
const proxyCreationCode = env("LOOM_PROXY_CREATION_CODE");
const deployer = env("LOOM_DEPLOYER"); // anvil-unlocked, devnet only
const CHAIN_ID = 31337n;
const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

// --- 1. A fresh software P-256 passkey (stands in for a device authenticator).
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
const pad = value => `0x${Buffer.from(value, "base64url").toString("hex").padStart(64, "0")}`;
const key = { x: pad(jwk.x), y: pad(jwk.y) };
console.log("1. passkey generated");

// --- 2. Derive the account address locally; the chain must agree.
// A real WebAuthn authenticator puts sha256(rpId) in the first 32 bytes of
// authenticatorData, and the validator compares those bytes against the
// rpIdHash registered here — so registration must use sha256. originHash is
// different: the contract keccak-hashes the origin bytes it receives, so the
// registered value stays keccak256.
const rpIdHash = `0x${crypto.createHash("sha256").update(RP_ID).digest("hex")}`;
const originHash = keccak256(stringToHex(ORIGIN));
const config = {
  entryPoint,
  guardianRoot: keccak256(stringToHex("minimal-account.guardians")),
  guardianThreshold: 1,
  configHash: keccak256(stringToHex("minimal-account.config")),
  modules: [
    { moduleTypeId: 4n, module: policyHook, initData: "0x" },
    {
      moduleTypeId: 1n,
      module: validator,
      initData: encodeFunctionData({
        abi: P256ValidatorAbi,
        functionName: "initialize",
        args: [key.x, key.y, rpIdHash, originHash, policyHook]
      })
    }
  ]
};
const salt = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["minimal-account", key.x]));
const account = deriveAccountAddress({ factory, implementation, proxyCreationCode, salt, config });
const liveAddress = `0x${(
  await ethCall(
    factory,
    encodeFunctionData({
      abi: LoomAccountFactoryAbi,
      functionName: "getAddress",
      args: [salt, config.guardianRoot, config.guardianThreshold, config.configHash, config.modules]
    })
  )
).slice(26)}`;
assert.equal(account.toLowerCase(), liveAddress.toLowerCase(), "local derivation disagrees with the factory");
console.log(`2. account derived locally and confirmed by the chain: ${account}`);

// --- 3. First operation: deploy the account and execute a call, signed by the
//        passkey over the canonical EntryPoint hash.
const signer = createPasskeySigner({
  credentialId: "minimal-account-passkey",
  rpId: RP_ID,
  origin: ORIGIN,
  validator,
  entryPoint,
  async signChallenge(challenge) {
    // The authenticator's job: sign sha256(authenticatorData || sha256(clientDataJSON))
    // where the WebAuthn challenge is the canonical user-operation hash.
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

const block = await rpc("eth_getBlockByNumber", ["latest", false]);
const fees = {
  maxFeePerGas: BigInt(block.baseFeePerGas ?? "0x0") * 2n + 2_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n
};
const setValue = value => encodeFunctionData({ abi: LoomAccountAbi, functionName: "execute", args: [
  `0x${"00".repeat(32)}`,
  encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
    [[target, 0n, encodeFunctionData({ abi: [{ type: "function", name: "setValue", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }], functionName: "setValue", args: [value] })]]
  )
]});

async function submit(unsignedOverrides) {
  const envelope = prepareUserOperationEnvelope({
    chainId: Number(CHAIN_ID),
    account,
    intent: {
      kind: "account.calls",
      chainId: Number(CHAIN_ID),
      account,
      calls: [],
      authority: { risk: "account-execution", requiresUserSignature: true, requiresGuardianApproval: false, delayRequired: false }
    },
    callGasLimit: 1_500_000n,
    verificationGasLimit: 6_000_000n,
    preVerificationGas: 200_000n,
    ...fees,
    ...unsignedOverrides
  });
  const signature = await signer.signUserOperation(envelope);
  const packed = packUserOperation({ ...envelope.userOperation, signature });

  // Local canonical hash must match what the live EntryPoint computes.
  const localHash = getUserOpHash(packed, entryPoint, CHAIN_ID);
  const liveHash = await ethCall(
    entryPoint,
    encodeFunctionData({ abi: EntryPointAbi, functionName: "getUserOpHash", args: [packed] })
  );
  assert.equal(localHash.toLowerCase(), liveHash.toLowerCase(), "local hash disagrees with the EntryPoint");

  const txHash = await rpc("eth_sendTransaction", [
    {
      from: deployer,
      to: entryPoint,
      gas: "0x7a1200",
      data: encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packed], deployer] })
    }
  ]);
  let receipt = null;
  for (let i = 0; i < 60 && receipt === null; i += 1) {
    receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (receipt === null) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(receipt?.status, "0x1", "handleOps transaction failed");
  return receipt;
}

await rpc("eth_sendTransaction", [
  {
    from: deployer,
    to: entryPoint,
    value: `0x${(10n ** 17n).toString(16)}`,
    data: encodeFunctionData({ abi: EntryPointAbi, functionName: "depositTo", args: [account] })
  }
]);
await submit({
  nonce: 0n,
  factory,
  factoryData: encodeCreateAccountCall(salt, config),
  callData: setValue(777n)
});
const readValue = async () =>
  BigInt(
    await ethCall(
      target,
      encodeFunctionData({ abi: [{ type: "function", name: "value", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "value" })
    )
  );
assert.equal(await readValue(), 777n, "first operation did not execute");
console.log("3. account deployed and first passkey-signed operation executed (value=777)");

// --- 4. Second operation on the deployed account, nonce read through the
//        public state transport.
const stateTransport = createRpcStateTransport({ endpoint: RPC_URL });
const nonce = await fetchEntryPointNonce({ stateTransport, entryPoint, account });
assert.equal(nonce, 1n, "unexpected EntryPoint nonce after deployment");
await submit({ nonce, callData: setValue(4242n) });
assert.equal(await readValue(), 4242n, "second operation did not execute");
console.log("4. second operation executed with the fetched nonce (value=4242)");

console.log("\nminimal-account: PASS — derived, deployed, and operated using only published packages");
