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
import { createTraceRecorder, nativeTransferScenario } from "../wallet-lab/dist/index.js";
import { writeWalletLabArtifact } from "../wallet-lab/node-artifact.mjs";
import { deterministicTestPasskey } from "../wallet-lab/test-passkey.mjs";
import { runBrowserWalletFlow } from "../wallet-lab/browser-wallet-flow.mjs";
import { buildDeploymentEvidence, compactOpcodeTrace, normalizeCallTrace, summarizeCallTrace } from "../wallet-lab/deployment-evidence.mjs";
import {
  deriveAccountAddress,
  getUserOpHash as coreGetUserOpHash,
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
const labArtifactPath = process.env.LOOM_WALLET_LAB_ARTIFACT;

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
let labRecorder;
try {
  console.log("==> loom devnet up (anvil + Loom + Alto)");
  state = await up({ stepsTracing: Boolean(labArtifactPath) });
  console.log(`    rpc ${state.rpcUrl} · bundler ${state.bundlerUrl} · alto ${state.alto}`);

  const { rpcUrl, bundlerUrl, addresses } = state;
  const entryPoint = addresses.EntryPoint;
  const factory = addresses.LoomAccountFactory;
  const validator = addresses.P256Validator;
  const policyHook = addresses.PolicyHook;
  const target = addresses.DevnetTarget;
  const deployer = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const versions = JSON.parse(readFileSync(join(repoRoot, "devnet", "versions.json"), "utf8"));
  const runtimeCodeHash = async address => keccak256(await rpcCall(rpcUrl, "eth_getCode", [address, "latest"]));
  let labCodeHashes = {};
  let deploymentEvidence = null;

  if (labArtifactPath) {
    labRecorder = createTraceRecorder({
      runId: process.env.LOOM_WALLET_LAB_RUN_ID ?? "wallet-lab-run",
      traceId: process.env.LOOM_WALLET_LAB_TRACE_ID ?? "00000000000000000000000000000000",
      scenario: nativeTransferScenario,
      onChange: artifact => writeWalletLabArtifact(labArtifactPath, artifact)
    });
    const environmentSpan = labRecorder.begin({
      component: "orchestrator",
      phase: "environment",
      explanation: "Starting the repository-pinned Anvil, Loom deployment, EntryPoint, and Alto bundler.",
      reproduction: "npm run wallet-lab:run",
      payload: { chainId: state.chainId, addresses }
    });
    labCodeHashes = {};
    for (const [name, address] of Object.entries(addresses)) labCodeHashes[name] = await runtimeCodeHash(address);
    labRecorder.setEnvironment({
      gitCommit: process.env.LOOM_WALLET_LAB_GIT_COMMIT ?? "unknown",
      dirty: process.env.LOOM_WALLET_LAB_GIT_DIRTY === "true",
      chainId: state.chainId,
      seed: nativeTransferScenario.seed,
      addresses,
      codeHashes: labCodeHashes,
      components: [
        { name: "Anvil", version: versions.foundry, endpoint: rpcUrl, status: "healthy" },
        { name: "Alto", version: versions.alto, endpoint: bundlerUrl, status: "healthy" },
        { name: "EntryPoint", version: "0.9.0", digest: labCodeHashes.EntryPoint, status: "healthy" },
        { name: "Loom contracts", version: process.env.LOOM_WALLET_LAB_GIT_COMMIT ?? "working-tree", digest: labCodeHashes.LoomAccount, status: "healthy" }
      ]
    });
    labRecorder.finish(environmentSpan, {
      status: "success",
      explanation: "All pinned local components passed startup health checks and published their exact addresses and runtime code hashes.",
      chainId: state.chainId,
      entryPoint,
      bundler: bundlerUrl,
      payload: { versions, codeHashes: labCodeHashes }
    });
  }

  // A deterministic software P-256 credential for this hermetic test only.
  // Its private scalar never enters the run artifact or a production package.
  const testPasskey = deterministicTestPasskey(nativeTransferScenario.seed);
  const { privateKey } = testPasskey;
  const key = testPasskey.publicKey;
  // Real WebAuthn authenticators put sha256(rpId) in authenticatorData[0:32],
  // and WebAuthnP256.verify compares those bytes against the registered
  // rpIdHash — so registration must use sha256, not keccak256. (originHash
  // stays keccak256: the contract keccak-hashes the origin bytes itself.)
  const rpIdHash = `0x${crypto.createHash("sha256").update(RP_ID).digest("hex")}`;
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
  let browserEvidence = null;
  if (process.env.LOOM_WALLET_LAB_BROWSER_FLOW === "true") {
    const browserDeployment = {
      chainId: state.chainId,
      entryPoint,
      factory,
      implementation,
      validator,
      policyHook,
      proxyCreationCode: proxyArtifact.bytecode.object,
      runtimeCodeHashes: {
        entryPoint: await runtimeCodeHash(entryPoint),
        factory: await runtimeCodeHash(factory),
        implementation: await runtimeCodeHash(implementation),
        validator: await runtimeCodeHash(validator),
        policyHook: await runtimeCodeHash(policyHook)
      }
    };
    browserEvidence = await runBrowserWalletFlow({
      rpcUrl,
      bundlerUrl,
      deployment: browserDeployment,
      recorder: labRecorder,
      rpcCall,
      deployer,
      encodeNonce: sender => encodeFunctionData({ abi: EntryPointAbi, functionName: "getNonce", args: [sender, 0n] })
    });
  }
  const accountResolutionSpan = labRecorder?.begin({
    component: "sdk",
    phase: "account-resolution",
    explanation: "Deriving the counterfactual account from the factory, immutable implementation, proxy creation code, salt, and module configuration.",
    source: { file: "tools/e2e/bundler-devnet.mjs", symbol: "deriveAccountAddress" },
    payload: { factory, implementation, salt, config }
  });
  const account = deriveAccountAddress({
    factory,
    implementation,
    proxyCreationCode: proxyArtifact.bytecode.object,
    salt,
    config
  });
  if (accountResolutionSpan) labRecorder.finish(accountResolutionSpan, {
    status: "success",
    explanation: "The SDK derived the exact account address used by the subsequent EntryPoint operation.",
    chainId: state.chainId,
    account,
    entryPoint,
    payload: { account, factory, implementation, salt }
  });
  console.log(`==> account derived: ${account}`);
  if (labRecorder) {
    deploymentEvidence = buildDeploymentEvidence({ repoRoot, addresses, codeHashes: labCodeHashes, account });
    const deploymentSpan = labRecorder.begin({
      component: "orchestrator",
      phase: "deployment",
      explanation: "Cataloging the exact local deployment addresses, runtime code hashes, ABI functions, and architectural relationships.",
      source: { file: "tools/wallet-lab/deployment-evidence.mjs", symbol: "buildDeploymentEvidence" },
      payload: { deployment: deploymentEvidence }
    });
    labRecorder.finish(deploymentSpan, {
      status: "success",
      chainId: state.chainId,
      account,
      entryPoint,
      payload: { deployment: deploymentEvidence }
    });
  }

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
  let lastPasskeyInspection = null;
  const signer = createPasskeySigner({
    credentialId: testPasskey.credentialId,
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
      lastPasskeyInspection = {
        credentialId: testPasskey.credentialId,
        rpId: RP_ID,
        rpIdHash,
        origin: ORIGIN,
        challenge: challenge.challenge,
        clientDataJSON: clientDataJSON.toString("utf8"),
        authenticatorData: `0x${authenticatorData.toString("hex")}`,
        flags: { up: true, uv: true },
        signCount: 0,
        signatureEncoding: "ieee-p1363-raw64",
        r: `0x${signature.subarray(0, 32).toString("hex")}`,
        s: `0x${signature.subarray(32).toString("hex")}`
      };
      return {
        authenticatorData: `0x${authenticatorData.toString("hex")}`,
        clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
        signature: `0x${signature.toString("hex")}`
      };
    }
  });
  const bundlerTransport = createBundlerTransport({ endpoint: bundlerUrl, entryPoint });
  const client = createLoomClient({
    chainId: state.chainId,
    account,
    signer,
    // No kohaku host: privacy is an optional layer and this smoke proves the
    // whole bundler pipeline needs none of it.
    transport: bundlerTransport,
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

  console.log("==> op 2 through Alto: observable native transfer (prepare, estimate, passkey, submit, include, finalize)");
  await rpcCall(rpcUrl, "eth_sendTransaction", [{ from: deployer, to: account, value: "0x3e8" }]);
  const snapshotId = await rpcCall(rpcUrl, "evm_snapshot", []);
  if (labRecorder) {
    const current = labRecorder.snapshot().environment;
    if (current) labRecorder.setEnvironment({ ...current, snapshotId });
  }
  const readDeposit = async () => BigInt(await rpcCall(rpcUrl, "eth_call", [{
    to: entryPoint,
    data: encodeFunctionData({ abi: EntryPointAbi, functionName: "balanceOf", args: [account] })
  }, "latest"]));
  const before = {
    targetBalance: BigInt(await rpcCall(rpcUrl, "eth_getBalance", [target, "latest"])),
    targetValue: await readValue(),
    accountNonce: await client.getEntryPointNonce(),
    entryPointDeposit: await readDeposit(),
    accountCodeHash: await runtimeCodeHash(account)
  };
  const stateBeforeSpan = labRecorder?.begin({
    component: "rpc",
    phase: "state-before",
    explanation: "Reading the semantic account, target, nonce, and EntryPoint deposit state before signing.",
    payload: before
  });
  if (stateBeforeSpan) labRecorder.finish(stateBeforeSpan, { status: "success", chainId: state.chainId, account, entryPoint, payload: before });

  const action = nativeTransferScenario.actions[0];
  assert.ok(action, "wallet lab native transfer action missing");
  const calls = [{ target, value: BigInt(action.valueWei), data: encodeFunctionData({ abi: setValueAbi, functionName: "setValue", args: [BigInt(action.targetCall.value)] }) }];
  const intentSpan = labRecorder?.begin({
    component: "wallet-ui",
    phase: "intent",
    explanation: "The user intends to send native value and invoke the deterministic devnet target in one atomic account call.",
    payload: { action, account, chainId: state.chainId }
  });
  if (intentSpan) labRecorder.finish(intentSpan, { status: "success", chainId: state.chainId, account, payload: { calls } });

  const constructionSpan = labRecorder?.begin({
    component: "sdk",
    phase: "call-construction",
    explanation: "Encoding the reviewed Loom single-call execution intent.",
    source: { file: "packages/sdk/src/index.ts", symbol: "prepareCalls" },
    payload: { calls }
  });
  const preparedSecond = client.prepareCalls({ calls });
  if (constructionSpan) labRecorder.finish(constructionSpan, {
    status: "success",
    account,
    payload: { intentHash: preparedSecond.intentHash, review: preparedSecond.review, intent: preparedSecond.intent }
  });

  const estimationSpan = labRecorder?.begin({
    component: "bundler",
    phase: "gas-estimation",
    status: "waiting-bundler",
    explanation: "The SDK resolves the nonce and fees, then asks Alto to simulate gas with the signer's representative dummy signature.",
    source: { file: "packages/sdk/src/index.ts", symbol: "fillUserOperation" },
    payload: { methods: ["eth_call:getNonce", "pimlico_getUserOperationGasPrice", "eth_estimateUserOperationGas"] }
  });
  const filledSecond = await client.fillUserOperation(preparedSecond);
  if (estimationSpan) labRecorder.finish(estimationSpan, {
    status: "simulated",
    chainId: state.chainId,
    account,
    entryPoint,
    bundler: bundlerUrl,
    payload: {
      nonce: filledSecond.userOperation.nonce,
      callGasLimit: filledSecond.userOperation.callGasLimit,
      verificationGasLimit: filledSecond.userOperation.verificationGasLimit,
      preVerificationGas: filledSecond.userOperation.preVerificationGas,
      maxFeePerGas: filledSecond.userOperation.maxFeePerGas,
      maxPriorityFeePerGas: filledSecond.userOperation.maxPriorityFeePerGas,
      note: "Simulation is not inclusion or success."
    }
  });

  lastPasskeyInspection = null;
  const signingSpan = labRecorder?.begin({
    component: "webauthn",
    phase: "webauthn",
    status: "waiting-user",
    explanation: "Requesting a test-only P-256 assertion bound to the canonical UserOperation hash, RP ID, and origin.",
    source: { file: "packages/sdk/src/index.ts", symbol: "createPasskeySigner" },
    payload: { credentialId: testPasskey.credentialId, rpId: RP_ID, origin: ORIGIN, userVerification: "required" }
  });
  const secondSignature = await signer.signUserOperation(filledSecond);
  const signedSecond = Object.freeze({ ...filledSecond, userOperation: Object.freeze({ ...filledSecond.userOperation, signature: secondSignature }) });
  const packedSecond = corePackUserOperation(signedSecond.userOperation);
  const independentlyComputedHash = coreGetUserOpHash(packedSecond, entryPoint, BigInt(state.chainId));
  if (signingSpan) labRecorder.finish(signingSpan, {
    status: "success",
    chainId: state.chainId,
    account,
    entryPoint,
    payload: { ...lastPasskeyInspection, userOpHash: independentlyComputedHash, unpacked: signedSecond.userOperation, packed: packedSecond }
  });

  const submissionSpan = labRecorder?.begin({
    component: "bundler",
    phase: "bundler-submission",
    status: "waiting-bundler",
    explanation: "Submitting the signed operation to Alto. Bundler acceptance is tracked separately from chain inclusion.",
    payload: { method: "eth_sendUserOperation", entryPoint, userOperation: signedSecond.userOperation }
  });
  const sentSecond = await bundlerTransport.sendUserOperation(signedSecond);
  assert.equal(sentSecond.userOpHash, independentlyComputedHash, "bundler and independent UserOperation hashes differ");
  if (submissionSpan) labRecorder.finish(submissionSpan, {
    status: "success",
    chainId: state.chainId,
    account,
    entryPoint,
    bundler: bundlerUrl,
    userOpHash: sentSecond.userOpHash,
    payload: {
      method: "eth_sendUserOperation",
      userOperation: signedSecond.userOperation,
      packedUserOperation: packedSecond,
      independentlyComputedHash,
      bundlerHash: sentSecond.userOpHash
    }
  });

  const inclusionSpan = labRecorder?.begin({
    component: "tracker",
    phase: "inclusion",
    status: "pending-chain",
    explanation: "Polling for an ERC-4337 receipt; submission and simulation are not treated as inclusion.",
    payload: { method: "eth_getUserOperationReceipt", userOpHash: sentSecond.userOpHash }
  });
  const secondReceipt = await client.waitForUserOperationReceipt({ userOpHash: sentSecond.userOpHash });
  const transactionReceipt = secondReceipt.receipt;
  const transactionHash = transactionReceipt?.transactionHash;
  const onChainReceipt = transactionHash ? await rpcCall(rpcUrl, "eth_getTransactionReceipt", [transactionHash]) : null;
  assert.equal(secondReceipt.userOpHash, independentlyComputedHash, "receipt UserOperation hash provenance mismatch");
  assert.equal(secondReceipt.sender?.toLowerCase(), account.toLowerCase(), "receipt sender provenance mismatch");
  assert.equal(onChainReceipt?.status, "0x1", "on-chain transaction receipt was not successful");
  if (inclusionSpan) labRecorder.finish(inclusionSpan, {
    status: "included",
    chainId: state.chainId,
    account,
    entryPoint,
    bundler: bundlerUrl,
    userOpHash: sentSecond.userOpHash,
    transactionHash,
    blockHash: onChainReceipt?.blockHash,
    blockNumber: Number(BigInt(onChainReceipt?.blockNumber ?? "0x0")),
    payload: { userOperationReceipt: secondReceipt, transactionReceipt: onChainReceipt }
  });
  if (labRecorder && deploymentEvidence) {
    const traceSpan = labRecorder.begin({
      component: "rpc",
      phase: "evm-trace",
      explanation: "Tracing the successful enclosing transaction with Anvil's call tracer and resolving observed selectors against the deployment ABI catalog.",
      payload: { method: "debug_traceTransaction", transactionHash }
    });
    const rawTrace = await rpcCall(rpcUrl, "debug_traceTransaction", [transactionHash, { tracer: "callTracer" }]);
    const rawOpcodeTrace = await rpcCall(rpcUrl, "debug_traceTransaction", [transactionHash, {
      disableMemory: true,
      disableStack: true,
      disableStorage: true
    }]);
    const trace = normalizeCallTrace(rawTrace, deploymentEvidence);
    const summary = summarizeCallTrace(trace);
    const opcodeProfile = compactOpcodeTrace(rawOpcodeTrace);
    assert.ok(trace && summary.calls > 0, "EVM call trace did not contain an observable call tree");
    assert.ok(opcodeProfile.totalSteps > 0, "EVM opcode trace did not contain execution steps");
    labRecorder.finish(traceSpan, {
      status: "success",
      chainId: state.chainId,
      account,
      entryPoint,
      transactionHash,
      userOpHash: sentSecond.userOpHash,
      payload: { method: "debug_traceTransaction", transactionHash, summary, trace, opcodeProfile }
    });
  }

  const includedBlock = Number(BigInt(onChainReceipt.blockNumber));
  const finalitySpan = labRecorder?.begin({
    component: "tracker",
    phase: "finality",
    status: "included",
    explanation: "Mining a later local block and applying the scenario's explicit one-block finality policy.",
    payload: { includedBlock, requiredConfirmations: 1 }
  });
  await rpcCall(rpcUrl, "evm_mine", []);
  const finalHead = Number(BigInt(await rpcCall(rpcUrl, "eth_blockNumber", [])));
  assert.ok(finalHead >= includedBlock + 1, "operation did not reach the local finality policy");
  if (finalitySpan) labRecorder.finish(finalitySpan, {
    status: "finalized",
    chainId: state.chainId,
    account,
    entryPoint,
    userOpHash: sentSecond.userOpHash,
    transactionHash,
    blockHash: onChainReceipt.blockHash,
    blockNumber: includedBlock,
    payload: { includedBlock, finalHead, confirmations: finalHead - includedBlock }
  });

  const second = Object.freeze({ userOpHash: sentSecond.userOpHash, userOperation: signedSecond.userOperation, receipt: secondReceipt });
  assert.equal(second.receipt?.success, true, "second user operation was not successful");
  assert.equal(await readValue(), 4242n, "second user operation did not execute");
  const after = {
    targetBalance: BigInt(await rpcCall(rpcUrl, "eth_getBalance", [target, "latest"])),
    targetValue: await readValue(),
    accountNonce: await client.getEntryPointNonce(),
    entryPointDeposit: await readDeposit(),
    accountCodeHash: await runtimeCodeHash(account)
  };
  assert.equal(after.targetBalance - before.targetBalance, BigInt(action.valueWei), "native transfer balance delta mismatch");
  if (labRecorder) {
    const stateAfterSpan = labRecorder.begin({ component: "rpc", phase: "state-after", explanation: "Reading semantic state after finalized execution.", payload: after });
    labRecorder.finish(stateAfterSpan, { status: "success", chainId: state.chainId, account, entryPoint, userOpHash: second.userOpHash, transactionHash, payload: after });
    labRecorder.setStateDiff([
      ...(browserEvidence ? [
        { name: "Browser recipient native balance", before: browserEvidence.before.recipientBalance.toString(), after: browserEvidence.after.recipientBalance.toString(), unit: "wei", explanation: "The actual wallet example transferred exactly 123 wei after a virtual WebAuthn assertion." },
        { name: "Browser account EntryPoint nonce", before: browserEvidence.before.nonce.toString(), after: browserEvidence.after.nonce.toString(), explanation: "The browser-driven transfer advanced the deterministic test account nonce exactly once." }
      ] : []),
      { name: "Target native balance", before: before.targetBalance.toString(), after: after.targetBalance.toString(), unit: "wei", explanation: "The target received exactly the value authorized by the reviewed account call." },
      { name: "Target value", before: before.targetValue.toString(), after: after.targetValue.toString(), explanation: "The target call executed through LoomAccount after validator and hook checks." },
      { name: "EntryPoint nonce", before: before.accountNonce.toString(), after: after.accountNonce.toString(), explanation: "The canonical nonce advanced once for the included UserOperation." },
      { name: "EntryPoint deposit", before: before.entryPointDeposit.toString(), after: after.entryPointDeposit.toString(), unit: "wei", explanation: "The account-funded EntryPoint deposit paid the operation's actual gas cost." },
      { name: "Account runtime code hash", before: before.accountCodeHash, after: after.accountCodeHash, explanation: "Execution did not change the immutable account runtime binding." }
    ]);
    labRecorder.setInvariant("sdk-entrypoint-userop-hash-match", "pass", "The independently computed EntryPoint hash equals the bundler-returned hash.");
    labRecorder.setInvariant("receipt-provenance-match", "pass", "The UserOperation receipt, sender, transaction hash, and successful chain receipt agree.");
    labRecorder.setInvariant("native-balance-delta-match", "pass", `The target balance increased by exactly ${action.valueWei} wei.`);
    labRecorder.setInvariant("target-state-transition-match", "pass", "The target value changed to the exact scenario value 4242.");
    labRecorder.setInvariant("finality-not-inferred-from-simulation", "pass", "Finality was recorded only after inclusion and a later local block.");
  }
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

  // The engine-free @loom/passkey signer, live: sign an operation with only
  // @loom/passkey + @loom/core (no wallet engine) and execute it through the
  // real EntryPoint. This is the web/mobile persona path — a passkey signer
  // that needs neither the bundler transport nor the privacy runtime.
  console.log("==> op 5 signed by @loom/passkey (engine-free) through the EntryPoint");
  const { createWebAuthnSigner } = await import("../../packages/passkey/dist/index.js");
  const passkeySigner = createWebAuthnSigner({
    validator,
    origin: ORIGIN,
    rpId: RP_ID,
    signChallenge(challenge) {
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
  // Nonce via a raw EntryPoint getNonce(address,uint192) call (selector
  // 0x35567e1a) — the op is assembled without the wallet engine on purpose.
  const nonceWord = await rpcCall(rpcUrl, "eth_call", [
    { to: entryPoint, data: `0x35567e1a${account.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}` },
    "latest"
  ]);
  const nonce = BigInt(nonceWord);
  const passkeyOp = {
    sender: account,
    nonce,
    callData: encodeFunctionData({
      abi: [{ type: "function", name: "execute", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [], stateMutability: "payable" }],
      functionName: "execute",
      args: [
        `0x${"00".repeat(32)}`,
        encodeAbiParameters(
          [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
          [[target, 0n, encodeFunctionData({ abi: setValueAbi, functionName: "setValue", args: [5555n] })]]
        )
      ]
    }),
    callGasLimit: 500_000n,
    verificationGasLimit: 800_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    signature: "0x"
  };
  // The hash the account validates is computed with @loom/core; the signer only
  // needs that hash, never the wallet engine.
  const packedForHash = corePackUserOperation(passkeyOp);
  const passkeyHash = coreGetUserOpHash(packedForHash, entryPoint, BigInt(state.chainId));
  const passkeySignature = await passkeySigner.sign(passkeyHash);
  const packedSigned = corePackUserOperation({ ...passkeyOp, signature: passkeySignature });
  await rpcCall(rpcUrl, "eth_sendTransaction", [
    { from: deployer, to: entryPoint, gas: "0x7a1200", data: encodeFunctionData({ abi: EntryPointAbi, functionName: "handleOps", args: [[packedSigned], deployer] }) }
  ]);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await readValue(), 5555n, "the @loom/passkey-signed operation did not execute");
  console.log("    ok  engine-free @loom/passkey signature validated on chain (value=5555)");

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

  // The backend UserOperation tracker, live: replay this devnet's real
  // EntryPoint logs through the framework-neutral tracker and require that
  // every operation the smoke sent is decoded and tracked to finalized.
  console.log("==> backend userop-tracker against the live devnet logs");
  const { createTracker } = await import("../../examples/backend-userop-tracker/src/tracker.mjs");
  const head = Number(BigInt(await rpcCall(rpcUrl, "eth_blockNumber", [])));
  const logs = (
    await rpcCall(rpcUrl, "eth_getLogs", [{ address: entryPoint, fromBlock: "0x0", toBlock: "latest" }])
  ).map(log => ({ address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber, blockHash: log.blockHash }));
  const tracked = [];
  const tracker = createTracker({ chainId: state.chainId, entryPoint, confirmations: 0, onEvent: e => tracked.push(e.type) });
  await tracker.ingest({ logs, head });
  const finalized = [];
  for (const userOpHash of [second.userOpHash, third.userOpHash, fourth.userOpHash]) {
    const record = await tracker.get(userOpHash);
    assert.ok(record, `tracker did not see ${userOpHash}`);
    assert.equal(record.status, "finalized", `operation ${userOpHash} not finalized`);
    assert.equal(record.success, true, `operation ${userOpHash} not successful on chain`);
    finalized.push(userOpHash);
  }
  console.log(`    ok  tracked ${finalized.length} bundler operations from real logs to finalized`);

  // The observability stack, live: connect this deployment from a manifest and
  // index it end to end — real logs -> tracker -> dashboard metrics -> the
  // Prometheus exposition an operator's Grafana would scrape.
  console.log("==> monitoring indexer + Prometheus metrics against the live devnet");
  const { createDashboardMetrics } = await import("../../monitoring/src/metrics.mjs");
  const { createIndexer } = await import("../../monitoring/src/indexer.mjs");
  const { renderPrometheus } = await import("../../monitoring/src/prometheus.mjs");
  const dashMetrics = createDashboardMetrics({ activeWindowSeconds: 24 * 3600, labels: { chain_id: String(state.chainId) } });
  const indexer = createIndexer({
    rpc: doctorRpc,
    metrics: dashMetrics,
    chainId: state.chainId,
    manifest: { chainId: state.chainId, entryPoint: { address: entryPoint }, factory: { address: factory }, deployBlock: 0 }
  });
  const indexed = await indexer.sync();
  const summary = dashMetrics.update();
  console.log(`    accounts=${summary.accounts} activeUsers=${summary.activeUsers} ops=${summary.totalOps} tvlWei=${summary.tvlWei} head=${summary.indexerHead}`);
  assert.ok(indexed.accounts >= 1, "indexer connected the factory and saw account creation");
  assert.ok(summary.totalOps >= 3, "indexer counted the bundler operations");
  assert.ok(summary.activeUsers >= 1, "at least one active user");
  assert.ok(summary.tvlWei > 0n, "TVL computed from real account balances");
  assert.ok(summary.indexerHead > 0, "indexer head recorded");
  const exposition = renderPrometheus(dashMetrics.registry.snapshot());
  // The full metric surface, including the RPC instrumentation the indexer's
  // measured transport produced against the real endpoint.
  for (const metricName of [
    "loom_tvl_wei",
    "loom_active_users",
    "loom_userops_total",
    "loom_tps",
    "loom_gas_cost_wei_avg",
    "loom_indexer_head_block",
    "loom_rpc_requests_total"
  ]) {
    assert.ok(exposition.includes(metricName), `Prometheus output missing ${metricName}`);
  }
  assert.ok(exposition.includes('chain_id="31337"'), "metrics carry the chain_id label");
  // Best-practice shape: totals are counters with a status label; RPC duration
  // is a real histogram (so rate()/histogram_quantile() are valid downstream).
  assert.ok(/# TYPE loom_userops_total counter/.test(exposition), "loom_userops_total is a counter");
  assert.ok(exposition.includes('status="success"'), "userops carry a status label");
  assert.ok(/# TYPE loom_rpc_duration_seconds histogram/.test(exposition), "rpc duration is a histogram");
  assert.ok(exposition.includes("loom_rpc_duration_seconds_bucket"), "histogram exposes buckets");
  console.log("    ok  best-practice metrics: counters with labels, histogram buckets, chain_id");

  // The read-only deployment verbs, live: assemble a canonical manifest from the
  // devnet's real code hashes and run `loom deploy verify` / `inspect` against
  // the chain — a pass on the honest manifest, a fail on a tampered one.
  console.log("==> loom deploy verify + manifest validate against the live devnet");
  const { verifyDeployment, inspectManifest, validateManifest } = await import("../../packages/cli/src/deploy.mjs");
  const proxyHash = keccak256(proxyArtifact.bytecode.object);
  const canonicalManifest = {
    schemaVersion: "1",
    releaseChannel: "devnet",
    chainId: state.chainId,
    entryPoint: { address: entryPoint, runtimeCodeHash: await runtimeCodeHash(entryPoint) },
    factory: { address: factory, runtimeCodeHash: await runtimeCodeHash(factory) },
    account: {
      implementation: { address: implementation, runtimeCodeHash: await runtimeCodeHash(implementation) },
      proxy: { creationCodeHash: proxyHash, runtimeCodeHash: proxyHash }
    },
    modules: [{ type: "validator", address: validator, runtimeCodeHash: await runtimeCodeHash(validator), version: "0.0.0", status: "beta" }],
    compatibility: { contractRelease: "0.0.0", sdkRange: "^0.0" }
  };
  const deployRpc = (method, params) => rpcCall(rpcUrl, method, params);
  const validation = await validateManifest(canonicalManifest, { rpc: deployRpc });
  assert.equal(validation.onChain.ok, true, "manifest validate confirmed all code hashes on chain");
  const verified = await verifyDeployment(canonicalManifest, deployRpc);
  assert.equal(verified.ok, true, "deploy verify passed against the honest manifest");
  const inspection = await inspectManifest(canonicalManifest, { rpc: deployRpc });
  assert.equal(inspection.entryPoint.state, "verified", "inspect labels the EntryPoint verified");
  assert.equal(inspection.modules[0].state, "verified", "inspect labels the validator verified");
  // A tampered EntryPoint hash must fail closed.
  const tampered = { ...canonicalManifest, entryPoint: { address: entryPoint, runtimeCodeHash: `0x${"00".repeat(32)}` } };
  await assert.rejects(verifyDeployment(tampered, deployRpc), e => e.exitCode === 6, "deploy verify fails on a tampered hash");
  console.log(`    ok  manifest ${verified.manifestHash} verified on chain; tampered hash rejected`);

  if (labRecorder) {
    const uiSpan = labRecorder.begin({ component: "wallet-ui", phase: "ui", explanation: "Publishing the correlated run artifact for the local laboratory UI.", payload: { artifactPath: labArtifactPath } });
    labRecorder.finish(uiSpan, { status: "success", chainId: state.chainId, account, entryPoint, userOpHash: second.userOpHash, payload: { artifactPath: labArtifactPath, replay: labRecorder.snapshot().replay.command } });
    labRecorder.complete("success");
  }

  console.log("\nBundler devnet passed: sovereign deployment plus the full SDK send pipeline against the pinned Alto bundler.");
} catch (error) {
  labRecorder?.fail(error);
  labRecorder?.complete("error");
  throw error;
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
