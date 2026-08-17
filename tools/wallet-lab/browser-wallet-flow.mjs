import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { deriveAccountAddress, getUserOpHash, packUserOperation, P256ValidatorAbi } from "../../packages/core/dist/index.js";
import { encodeAbiParameters, encodeFunctionData, keccak256, sha256, stringToHex } from "viem";
import { deterministicTestPasskey } from "./test-passkey.mjs";
import { annotateNetworkExchange } from "./network-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const exampleRoot = join(repoRoot, "examples", "passkey-wallet-web");
const generatedDeployment = join(exampleRoot, "public", "wallet-lab.deployment.json");
const browserOutput = join(repoRoot, ".loom", "wallet-lab");
const RECIPIENT = "0x000000000000000000000000000000000000bEEF";
const RP_ID = "localhost";
const ORIGIN = "http://localhost:5174";
const ZERO32 = `0x${"00".repeat(32)}`;

function browserExecutable() {
  const explicit = process.env.LOOM_WALLET_LAB_BROWSER;
  const candidates = [
    explicit,
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  const selected = candidates.find(candidate => existsSync(candidate));
  if (!selected) throw new Error("Wallet Lab needs a local Chromium-family browser. Set LOOM_WALLET_LAB_BROWSER to its executable path.");
  return selected;
}

async function waitForUrl(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wallet example exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Startup race. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("wallet example did not become healthy within 30 seconds");
}

function jsonRpcBody(request) {
  try { return request.postDataJSON(); } catch { return null; }
}

function deterministicBrowserHandle(deployment) {
  const passkey = deterministicTestPasskey("loom-wallet-lab-browser-phase-1");
  const credentialId = `0x${Buffer.from(passkey.credentialId, "base64url").toString("hex")}`;
  const configHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }],
    [passkey.publicKey.x, passkey.publicKey.y, deployment.validator, deployment.policyHook]
  ));
  const salt = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [passkey.publicKey.x, passkey.publicKey.y]
  ));
  const config = {
    entryPoint: deployment.entryPoint,
    guardianRoot: ZERO32,
    guardianThreshold: 0,
    configHash,
    modules: [
      { moduleTypeId: 4n, module: deployment.policyHook, initData: "0x" },
      {
        moduleTypeId: 1n,
        module: deployment.validator,
        initData: encodeFunctionData({
          abi: P256ValidatorAbi,
          functionName: "initialize",
          args: [passkey.publicKey.x, passkey.publicKey.y, sha256(stringToHex(RP_ID)), keccak256(stringToHex(ORIGIN)), deployment.policyHook]
        })
      }
    ]
  };
  const account = deriveAccountAddress({
    factory: deployment.factory,
    implementation: deployment.implementation,
    proxyCreationCode: deployment.proxyCreationCode,
    salt,
    config
  });
  return {
    passkey,
    handle: {
      version: 1,
      kind: "derived",
      id: `${deployment.chainId}:${account.toLowerCase()}`,
      label: "Wallet Lab browser account",
      account,
      chainId: deployment.chainId,
      credentialId,
      publicKey: passkey.publicKey,
      rpId: RP_ID,
      origin: ORIGIN,
      salt,
      creation: { guardianRoot: ZERO32, guardianThreshold: 0 }
    }
  };
}

export async function runBrowserWalletFlow(input) {
  const { rpcUrl, bundlerUrl, deployment, recorder, rpcCall } = input;
  const browserRpcUrl = `${ORIGIN}/wallet-lab/rpc`;
  const browserBundlerUrl = `${ORIGIN}/wallet-lab/bundler`;
  writeFileSync(generatedDeployment, `${JSON.stringify(deployment, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const vite = spawn(process.execPath, [join(exampleRoot, "node_modules", "vite", "bin", "vite.js"), exampleRoot, "--host", "127.0.0.1", "--port", "5174", "--strictPort"], {
    cwd: exampleRoot,
    env: {
      ...process.env,
      VITE_LOOM_DEPLOYMENT_PATH: "/wallet-lab.deployment.json",
      LOOM_WALLET_LAB_RPC_TARGET: rpcUrl,
      LOOM_WALLET_LAB_BUNDLER_TARGET: bundlerUrl
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let viteError = "";
  vite.stderr.on("data", chunk => { viteError += String(chunk); });
  let browser;
  let context;
  let page;
  try {
    await waitForUrl("http://127.0.0.1:5174/", vite);
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const deterministic = deterministicBrowserHandle(deployment);
    await context.addInitScript(({ rpcUrl: rpc, bundlerUrl: bundler, handle }) => {
      localStorage.setItem("loom.wallet.network.v1", JSON.stringify({
        rpcUrl: rpc,
        verificationRpcUrl: `${rpc}?verification=wallet-lab`,
        bundlerUrl: bundler,
        explorerUrl: "http://127.0.0.1:8545",
        relayUrl: ""
      }));
      localStorage.setItem("loom.wallet.accounts.v1", JSON.stringify([handle]));
    }, { rpcUrl: browserRpcUrl, bundlerUrl: browserBundlerUrl, handle: deterministic.handle });
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: Buffer.from(deterministic.passkey.credentialId, "base64url").toString("base64"),
        isResidentCredential: true,
        rpId: RP_ID,
        privateKey: deterministic.passkey.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
        userHandle: Buffer.from("loom-wallet-lab-browser-user", "utf8").toString("base64"),
        signCount: 0
      }
    });
    // Start only after provisioning the virtual credential so private PKCS#8
    // test material cannot become part of a Playwright trace.
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    let assertions = 0;
    cdp.on("WebAuthn.credentialAsserted", () => { assertions += 1; });
    const rpcExchanges = [];
    const responseCaptures = [];
    let currentNetworkOperation = "wallet-discovery";
    const requestOperations = new WeakMap();
    page.on("request", request => {
      if (request.method() === "POST" && [browserRpcUrl, browserBundlerUrl].includes(request.url())) {
        requestOperations.set(request, currentNetworkOperation);
      }
    });
    page.on("response", response => {
      const request = response.request();
      if (request.method() !== "POST" || ![browserRpcUrl, browserBundlerUrl].includes(request.url())) return;
      const body = jsonRpcBody(request);
      if (!body?.method) return;
      const operation = requestOperations.get(request) ?? currentNetworkOperation;
      const capture = (async () => {
        try {
          rpcExchanges.push(annotateNetworkExchange({
            transport: request.url() === browserBundlerUrl ? "bundler" : "rpc",
            endpoint: request.url(),
            status: response.status(),
            ok: response.ok(),
            request: body,
            response: await response.json()
          }, operation));
        } catch { /* Ignore non-JSON diagnostics. */ }
      })();
      responseCaptures.push(capture);
    });

    const uiSpan = recorder?.begin({
      component: "wallet-ui",
      phase: "ui",
      explanation: "Opening the actual Loom passkey wallet example on the generated local deployment profile.",
      reproduction: "npm run wallet-lab:run",
      payload: { url: ORIGIN, deployment: "/wallet-lab.deployment.json" }
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Wallet Lab browser account /u }).click();
    await page.getByRole("button", { name: "Receive", exact: true }).waitFor();
    const account = deterministic.handle;
    assert.match(account?.account ?? "", /^0x[0-9a-fA-F]{40}$/u, "browser wallet did not persist a valid account handle");
    const browserRpcProbe = await page.evaluate(async ({ rpcUrl: endpoint, account: address }) => {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] })
        });
        return { ok: response.ok, status: response.status, body: await response.text() };
      } catch (error) {
        return { ok: false, error: { name: error?.name, message: error?.message } };
      }
    }, { rpcUrl: browserRpcUrl, account: account.account });
    assert.equal(browserRpcProbe.ok, true, `browser cannot read the local RPC: ${JSON.stringify(browserRpcProbe)}`);
    const credentials = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    assert.equal(credentials.credentials.length, 1, "browser wallet did not load exactly one deterministic test credential");
    if (uiSpan) recorder.finish(uiSpan, {
      status: "success",
      chainId: deployment.chainId,
      account: account.account,
      payload: { label: account.label, account: account.account, credentialId: account.credentialId, rpId: account.rpId, origin: account.origin, source: "deterministic virtual authenticator" }
    });

    await rpcCall(rpcUrl, "eth_sendTransaction", [{ from: input.deployer, to: account.account, value: "0xde0b6b3a7640000" }]);
    currentNetworkOperation = "account-activation";
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Activate account" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Activate account" }).click();
    const activationSuccess = page.getByText("Account created", { exact: true });
    const activationFailure = page.getByText("Account could not be created", { exact: true });
    await activationSuccess.or(activationFailure).waitFor({ timeout: 60_000 });
    if (await activationFailure.isVisible()) {
      throw new Error(`browser account activation failed before completion; observed bundler methods: ${rpcExchanges.map(exchange => exchange.request.method).join(", ") || "none"}`);
    }

    currentNetworkOperation = "native-transfer";
    const before = {
      recipientBalance: BigInt(await rpcCall(rpcUrl, "eth_getBalance", [RECIPIENT, "latest"])),
      nonce: BigInt(await rpcCall(rpcUrl, "eth_call", [{ to: deployment.entryPoint, data: input.encodeNonce(account.account) }, "latest"]))
    };
    const intentSpan = recorder?.begin({
      component: "wallet-ui",
      phase: "intent",
      explanation: "The wallet user selected native ETH, entered a recipient and exact amount, then requested passkey signing.",
      payload: { account: account.account, recipient: RECIPIENT, valueWei: "123" }
    });
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await page.getByLabel("Recipient address").fill(RECIPIENT);
    await page.getByLabel("Amount (ETH)").fill("0.000000000000000123");
    const passkeySpan = recorder?.begin({
      component: "webauthn",
      phase: "webauthn",
      status: "waiting-user",
      explanation: "The Chromium virtual authenticator is performing a UV-capable P-256 assertion for the browser SDK UserOperation.",
      payload: { credentialId: account.credentialId, rpId: RP_ID, origin: ORIGIN, userVerification: "required" }
    });
    await page.getByRole("button", { name: "Sign & send with passkey" }).click();
    if (intentSpan) recorder.finish(intentSpan, { status: "success", chainId: deployment.chainId, account: account.account });
    await page.getByText("Sent ETH", { exact: true }).waitFor({ timeout: 60_000 });
    await Promise.all(responseCaptures);
    if (passkeySpan) recorder.finish(passkeySpan, {
      status: "success",
      chainId: deployment.chainId,
      account: account.account,
      payload: { credentialId: account.credentialId, rpId: RP_ID, origin: ORIGIN, assertedCeremonies: assertions, credentialMaterialStored: false }
    });

    const sends = rpcExchanges.filter(exchange => exchange.request.method === "eth_sendUserOperation" && exchange.response?.result);
    assert.ok(sends.length >= 2, "browser did not submit activation and transfer UserOperations");
    const transfer = sends.at(-1);
    const userOperation = transfer.request.params[0];
    const userOpHash = transfer.response.result;
    const independentHash = getUserOpHash(packUserOperation(userOperation), deployment.entryPoint, BigInt(deployment.chainId));
    assert.equal(userOpHash, independentHash, "browser SDK and independent EntryPoint UserOperation hashes differ");
    const submissionSpan = recorder?.begin({
      component: "bundler",
      phase: "bundler-submission",
      explanation: "The actual wallet example submitted its passkey-signed UserOperation and the returned hash matched an independent EntryPoint calculation.",
      payload: { method: "eth_sendUserOperation", userOperation, independentHash }
    });
    if (submissionSpan) recorder.finish(submissionSpan, {
      status: "success",
      chainId: deployment.chainId,
      account: account.account,
      entryPoint: deployment.entryPoint,
      bundler: bundlerUrl,
      userOpHash,
      payload: {
        method: "eth_sendUserOperation",
        userOperation,
        packedUserOperation: packUserOperation(userOperation),
        independentHash,
        bundlerHash: userOpHash
      }
    });
    const receipt = rpcExchanges.filter(exchange => exchange.request.method === "eth_getUserOperationReceipt" && exchange.response?.result?.userOpHash === userOpHash).at(-1)?.response.result;
    assert.ok(receipt, "browser did not receive its transfer UserOperation receipt");
    assert.equal(receipt.sender.toLowerCase(), account.account.toLowerCase(), "browser receipt sender mismatch");
    assert.equal(receipt.success, true, "browser transfer receipt reports failure");
    const transactionHash = receipt.receipt?.transactionHash ?? receipt.transactionHash;
    const chainReceipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [transactionHash]);
    assert.equal(chainReceipt?.status, "0x1", "browser transfer chain receipt was not successful");
    const inclusionSpan = recorder?.begin({
      component: "tracker",
      phase: "inclusion",
      explanation: "The browser operation has a matching ERC-4337 receipt and successful enclosing chain transaction.",
      payload: { receipt, chainReceipt }
    });
    if (inclusionSpan) recorder.finish(inclusionSpan, {
      status: "included",
      chainId: deployment.chainId,
      account: account.account,
      entryPoint: deployment.entryPoint,
      bundler: bundlerUrl,
      userOpHash,
      transactionHash,
      blockHash: chainReceipt.blockHash,
      blockNumber: Number(BigInt(chainReceipt.blockNumber)),
      payload: { receipt, chainReceipt }
    });
    await rpcCall(rpcUrl, "evm_mine", []);
    const includedBlock = Number(BigInt(chainReceipt.blockNumber));
    const head = Number(BigInt(await rpcCall(rpcUrl, "eth_blockNumber", [])));
    assert.ok(head >= includedBlock + 1, "browser transfer did not reach local finality");
    const after = {
      recipientBalance: BigInt(await rpcCall(rpcUrl, "eth_getBalance", [RECIPIENT, "latest"])),
      nonce: BigInt(await rpcCall(rpcUrl, "eth_call", [{ to: deployment.entryPoint, data: input.encodeNonce(account.account) }, "latest"]))
    };
    assert.equal(after.recipientBalance - before.recipientBalance, 123n, "browser transfer recipient delta mismatch");
    assert.equal(after.nonce - before.nonce, 1n, "browser transfer nonce delta mismatch");
    const browserSpan = recorder?.begin({
      component: "tracker",
      phase: "finality",
      explanation: "Correlating the browser-submitted UserOperation with its successful chain receipt and later local block.",
      payload: { userOperation, receipt, before, after, independentHash }
    });
    if (browserSpan) recorder.finish(browserSpan, {
      status: "finalized",
      chainId: deployment.chainId,
      account: account.account,
      entryPoint: deployment.entryPoint,
      bundler: bundlerUrl,
      userOpHash,
      transactionHash,
      blockHash: chainReceipt.blockHash,
      blockNumber: includedBlock,
      payload: {
        finalHead: head,
        confirmations: head - includedBlock,
        recipient: RECIPIENT,
        valueWei: "123",
        screenshot: ".loom/wallet-lab/wallet-example.png",
        browserTrace: ".loom/wallet-lab/browser-trace.zip"
      }
    });
    const networkSpan = recorder?.begin({
      component: "rpc",
      phase: "network",
      explanation: "Captured the browser wallet's local RPC and bundler JSON-RPC exchanges for this deterministic run.",
      payload: { exchanges: rpcExchanges }
    });
    if (networkSpan) recorder.finish(networkSpan, {
      status: "success",
      chainId: deployment.chainId,
      account: account.account,
      bundler: bundlerUrl,
      payload: { exchanges: rpcExchanges }
    });
    await page.screenshot({ path: join(browserOutput, "wallet-example.png"), fullPage: true });
    await context.tracing.stop({ path: join(browserOutput, "browser-trace.zip") });
    return { account: account.account, userOpHash, transactionHash, recipient: RECIPIENT, before, after };
  } catch (error) {
    if (page) {
      try {
        await page.screenshot({ path: join(browserOutput, "wallet-example.failed.png"), fullPage: true });
        console.error(`wallet example visible text:\n${(await page.locator("body").innerText()).slice(0, 4_000)}`);
      } catch { /* Preserve the primary failure. */ }
    }
    if (context) {
      try { await context.tracing.stop({ path: join(browserOutput, "browser-trace.failed.zip") }); } catch { /* Preserve the primary failure. */ }
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    if (vite.exitCode === null) {
      vite.kill();
      await new Promise(resolve => vite.once("exit", resolve));
    }
    rmSync(generatedDeployment, { force: true });
    if (viteError && vite.exitCode && vite.exitCode !== 0) console.error(viteError);
  }
}
