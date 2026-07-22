// The sponsor backend: what a fintech runs so its users get an account without
// ever holding ETH, seeing a transaction, or approving anything but a biometric
// prompt.
//
// The browser sends one thing — a creation operation already signed by the
// user's passkey. This service pays for it and publishes it. It cannot alter
// the operation (any edit invalidates the signature) and it holds no authority
// over the account it just paid to create. That asymmetry is the whole point:
// the institution funds onboarding, the user keeps control.
//
// Creation goes straight to the EntryPoint because the factory fail-closes to
// `entryPoint.senderCreator()`, so no third-party bundler can validate initCode.
//
// Usage:
//   SEPOLIA_SPONSOR_PRIVATE_KEY=0x… node examples/passkey-wallet-web/sponsor-server.mjs \
//     --rpc-url <url> [--port 8787] [--deposit 0.02]

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { EntryPointAbi } from "@loom/core";

// Runnable on its own, so it reads .env itself rather than relying on dev.mjs.
const envFile = join(dirname(fileURLToPath(import.meta.url)), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const argv = process.argv.slice(2);
const flag = name => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const rpcUrl = flag("rpc-url") ?? process.env.SEPOLIA_RPC_URL;
const port = Number(flag("port") ?? process.env.SPONSOR_PORT ?? 8787);
const deposit = parseEther(flag("deposit") ?? process.env.SPONSOR_DEPOSIT_ETH ?? "0.02");
const entryPoint = flag("entry-point") ?? "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
const key = process.env.SEPOLIA_SPONSOR_PRIVATE_KEY;

if (!rpcUrl) throw new Error("--rpc-url or SEPOLIA_RPC_URL is required");
if (!key) throw new Error("SEPOLIA_SPONSOR_PRIVATE_KEY is required (never pass the key in argv)");
// The template ships with `0x`, so an unfilled .env must fail here and say so
// rather than deeper in a key parser.
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  throw new Error(
    `SEPOLIA_SPONSOR_PRIVATE_KEY is not a 32-byte hex key (got ${key.length} characters). ` +
    "Fill it in .env — the template ships with a placeholder."
  );
}

const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const sponsor = privateKeyToAccount(key);
const wallet = createWalletClient({ account: sponsor, chain: sepolia, transport: http(rpcUrl) });

// Serialized: one account creation at a time, so concurrent requests cannot
// reuse a nonce and knock each other out.
let queue = Promise.resolve();
const serialize = task => (queue = queue.then(task, task));

function revertDetail(error) {
  const data = error.walk?.(e => typeof e?.data === "string")?.data ?? error.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length > 10) {
    try {
      const decoded = decodeErrorResult({ abi: EntryPointAbi, data });
      return `${decoded.errorName}(${decoded.args.join(", ")})`;
    } catch {}
  }
  return error.shortMessage ?? error.message;
}

// accountGasLimits packs verificationGasLimit || callGasLimit; gasFees packs
// maxPriorityFeePerGas || maxFeePerGas — 16 bytes each.
const highHalf = word => BigInt(`0x${word.slice(2, 34)}`);
const lowHalf = word => BigInt(`0x${word.slice(34, 66)}`);
const maxCost = op =>
  (BigInt(op.preVerificationGas) + highHalf(op.accountGasLimits) + lowHalf(op.accountGasLimits)) * lowHalf(op.gasFees);

async function deploy(packed, { selfFunded = false } = {}) {
  const existing = await publicClient.getCode({ address: packed.sender });
  if (existing && existing !== "0x") return { alreadyDeployed: true, account: packed.sender };

  // Refuse before spending: a signature this service cannot validate is a
  // signature it must not pay for.
  try {
    await publicClient.simulateContract({
      address: entryPoint, abi: EntryPointAbi, functionName: "handleOps",
      args: [[packed], sponsor.address], account: sponsor,
      stateOverride: [{ address: packed.sender, balance: deposit * 10n }]
    });
  } catch (error) {
    throw new Error(`operation would revert, not sponsoring: ${revertDetail(error)}`);
  }

  // Two different balances can be short here, and confusing them wastes time:
  // the account pays the operation, the submitter fronts transaction gas and is
  // reimbursed. Name whichever one is missing.
  const required = maxCost(packed);
  const submitterBalance = await publicClient.getBalance({ address: sponsor.address });
  if (submitterBalance < required) {
    throw new Error(
      `submitter ${sponsor.address} holds ${formatEther(submitterBalance)} ETH, not enough to front ` +
      `${formatEther(required)} ETH of transaction gas (it is reimbursed afterwards)`
    );
  }

  let depositTx = null;
  if (selfFunded) {
    // The account pays its own way; this service only fronts transaction gas
    // and is reimbursed as beneficiary. Check before sending anything.
    const balance = await publicClient.getBalance({ address: packed.sender });
    if (balance < required) {
      throw new Error(
        `account holds ${formatEther(balance)} ETH but the operation can cost up to ${formatEther(required)} ETH`
      );
    }
  } else {
    depositTx = await wallet.writeContract({
      address: entryPoint, abi: EntryPointAbi, functionName: "depositTo", args: [packed.sender], value: deposit
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
  }

  const opTx = await wallet.writeContract({
    address: entryPoint, abi: EntryPointAbi, functionName: "handleOps", args: [[packed], sponsor.address]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: opTx });

  const code = await publicClient.getCode({ address: packed.sender });
  const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  if (size === 0) throw new Error(`handleOps landed (${opTx}) but the account has no code`);

  return {
    account: packed.sender, depositTx, opTx, codeSize: size,
    gasUsed: receipt.gasUsed.toString(), fundedBy: selfFunded ? "account" : "sponsor"
  };
}

const server = createServer((req, res) => {
  // The page is served from a different port, so it is a cross-origin caller.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  // Read-only account status, so a returning user's page can say whether their
  // account is on chain without shipping its own RPC endpoint to the browser.
  if (req.method === "GET" && req.url.startsWith("/account")) {
    const address = new URL(req.url, "http://localhost").searchParams.get("address");
    if (!address) {
      return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "address required" }));
    }
    return void (async () => {
      try {
        const code = await publicClient.getCode({ address });
        const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
        const balance = await publicClient.getBalance({ address });
        // The nonce and fees an operation needs, read from the chain so the page
        // does not have to guess them or carry an RPC endpoint of its own.
        const nonce = size > 0
          ? await publicClient.readContract({
              address: entryPoint,
              abi: [{ type: "function", name: "getNonce", stateMutability: "view",
                      inputs: [{ type: "address" }, { type: "uint192" }], outputs: [{ type: "uint256" }] }],
              functionName: "getNonce", args: [address, 0n]
            })
          : 0n;
        const block = await publicClient.getBlock();
        const tip = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 1_000_000n);
        const deposit = await publicClient.readContract({
          address: entryPoint,
          abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
          functionName: "balanceOf", args: [address]
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          address, deployed: size > 0, codeSize: size, balance: formatEther(balance),
          deposit: formatEther(deposit), chainId: sepolia.id, nonce: nonce.toString(),
          // Doubling the base fee leaves room for it to rise before inclusion.
          maxFeePerGas: ((block.baseFeePerGas ?? 1_000_000_000n) * 2n + tip).toString(),
          maxPriorityFeePerGas: tip.toString()
        }));
      } catch (error) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
    })();
  }

  // Relay an operation for an account that already exists. No deposit and no
  // creation: the account pays from its own EntryPoint deposit and this only
  // carries the operation to the chain.
  if (req.method === "POST" && req.url.startsWith("/submit")) {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100_000) req.destroy();
    });
    return void req.on("end", () => {
      serialize(async () => {
        try {
          const raw = JSON.parse(body);
          const packed = { ...raw, nonce: BigInt(raw.nonce), preVerificationGas: BigInt(raw.preVerificationGas) };
          console.log(`==> relay request for ${packed.sender} (nonce ${packed.nonce})`);
          try {
            await publicClient.simulateContract({
              address: entryPoint, abi: EntryPointAbi, functionName: "handleOps",
              args: [[packed], sponsor.address], account: sponsor
            });
          } catch (error) {
            throw new Error(`operation would revert, not relaying: ${revertDetail(error)}`);
          }
          const opTx = await wallet.writeContract({
            address: entryPoint, abi: EntryPointAbi, functionName: "handleOps", args: [[packed], sponsor.address]
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash: opTx });
          const result = { account: packed.sender, opTx, status: receipt.status, gasUsed: receipt.gasUsed.toString() };
          console.log(`    ${JSON.stringify(result)}`);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch (error) {
          console.log(`    refused: ${error.message}`);
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
        }
      });
    });
  }

  if (req.method !== "POST" || !req.url.startsWith("/deploy")) {
    return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "POST /deploy or GET /account?address=…" }));
  }

  let body = "";
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 100_000) req.destroy();
  });
  req.on("end", () => {
    serialize(async () => {
      try {
        const raw = JSON.parse(body);
        const selfFunded = new URL(req.url, "http://localhost").searchParams.get("mode") === "self-funded";
        const packed = { ...raw, nonce: BigInt(raw.nonce), preVerificationGas: BigInt(raw.preVerificationGas) };
        console.log(`==> deploy request for ${packed.sender}${selfFunded ? " (self-funded)" : ""}`);
        const result = await deploy(packed, { selfFunded });
        console.log(`    ${JSON.stringify(result)}`);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        console.log(`    refused: ${error.message}`);
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
    });
  });
});

server.listen(port, async () => {
  console.log(`sponsor  ${sponsor.address}`);
  console.log(`balance  ${formatEther(await publicClient.getBalance({ address: sponsor.address }))} ETH`);
  console.log(`deposit  ${formatEther(deposit)} ETH per account`);
  console.log(`listening on http://localhost:${port}/deploy`);
  console.log("\nNOTE: this endpoint is unauthenticated and pays for anyone who calls it.");
  console.log("A real deployment puts it behind the institution's own user authentication.");
});
