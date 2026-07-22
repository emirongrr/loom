// Publish a passkey-signed creation operation and pay for it.
//
// This is the sponsor half of gasless onboarding: the user signed the operation
// with their passkey in the browser and holds no ETH; this script funds the
// account's EntryPoint deposit and submits the operation. The sponsor pays and
// gains nothing — it cannot alter the operation without invalidating the
// signature, and it never holds account authority.
//
// Creation is published straight to the EntryPoint because the factory
// fail-closes to `entryPoint.senderCreator()`, so a third-party bundler cannot
// simulate initCode. Every operation after this one is ordinary bundler traffic.
//
// Usage:
//   SEPOLIA_SPONSOR_PRIVATE_KEY=0x… \
//   node examples/passkey-wallet-web/sponsor-deploy.mjs \
//     --rpc-url <url> --op deploy-userop.json [--deposit 0.02] [--dry-run]
//
// The key is read from the environment, never from argv, so it stays out of
// process listings and shell history.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { EntryPointAbi } from "@loom/core";

const envFile = join(dirname(fileURLToPath(import.meta.url)), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const argv = process.argv.slice(2);
const flag = name => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const rpcUrl = flag("rpc-url") ?? process.env.SEPOLIA_RPC_URL;
const opPath = flag("op");
const deposit = parseEther(flag("deposit") ?? "0.02");
const dryRun = argv.includes("--dry-run");
// Self-funded: the account already holds ETH and pays its own prefund, so the
// submitter only fronts transaction gas and is reimbursed as beneficiary. Use
// this when the user funds their own account instead of an institution doing it.
const selfFunded = argv.includes("--no-deposit");
const key = process.env.SEPOLIA_SPONSOR_PRIVATE_KEY;

if (!rpcUrl) throw new Error("--rpc-url or SEPOLIA_RPC_URL is required");
if (!opPath) throw new Error("--op <deploy-userop.json> is required");
// A dry run spends nothing and signs nothing, so it must not demand the key —
// checking an operation should never require unlocking the funds.
if (!dryRun && !key) throw new Error("SEPOLIA_SPONSOR_PRIVATE_KEY is required (never pass the key in argv)");
if (dryRun && !key && !flag("sponsor")) throw new Error("--sponsor <address> is required for --dry-run");

// bigint fields are serialized as strings by the browser; restore them.
const raw = JSON.parse(readFileSync(opPath, "utf8"));
const op = {
  ...raw,
  nonce: BigInt(raw.nonce),
  preVerificationGas: BigInt(raw.preVerificationGas)
};

// accountGasLimits packs verificationGasLimit || callGasLimit, and gasFees packs
// maxPriorityFeePerGas || maxFeePerGas — 16 bytes each, per PackedUserOperation.
const highHalf = word => BigInt(`0x${word.slice(2, 34)}`);
const lowHalf = word => BigInt(`0x${word.slice(34, 66)}`);
const accountGasLimitsTotal = operation => highHalf(operation.accountGasLimits) + lowHalf(operation.accountGasLimits);
const maxFeePerGas = operation => lowHalf(operation.gasFees);

const entryPoint = flag("entry-point") ?? "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const sponsor = key ? privateKeyToAccount(key) : { address: flag("sponsor") };
const wallet = key ? createWalletClient({ account: sponsor, chain: sepolia, transport: http(rpcUrl) }) : null;

console.log(`sponsor      ${sponsor.address}`);
console.log(`balance      ${formatEther(await publicClient.getBalance({ address: sponsor.address }))} ETH`);
console.log(`account      ${op.sender}`);
console.log(`entryPoint   ${entryPoint}`);

const existing = await publicClient.getCode({ address: op.sender });
if (existing && existing !== "0x") {
  console.log("\naccount already has code — nothing to deploy");
  process.exit(0);
}

// Simulate before spending anything: handleOps reverts loudly on a bad
// signature or an underfunded deposit, and a simulation costs nothing.
const currentDeposit = await publicClient.readContract({
  address: entryPoint,
  abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "balanceOf",
  args: [op.sender]
});
const required = (BigInt(op.preVerificationGas) + accountGasLimitsTotal(op)) * maxFeePerGas(op);
console.log(`deposit      ${formatEther(currentDeposit)} ETH${selfFunded ? "" : ` (funding ${formatEther(deposit)} ETH)`}`);
console.log(`max cost     ${formatEther(required)} ETH  (${accountGasLimitsTotal(op) + BigInt(op.preVerificationGas)} gas at ${maxFeePerGas(op)} wei)`);
if (selfFunded) {
  const balance = await publicClient.getBalance({ address: op.sender });
  console.log(`account bal  ${formatEther(balance)} ETH => ${balance >= required ? "sufficient" : "NOT ENOUGH, send more to the account"}`);
}

if (dryRun) {
  // Simulate with the account's balance overridden, so validation can pay its
  // own prefund and the run tests the signature rather than stopping at AA21
  // for an empty deposit. Nothing is spent: the override exists only inside
  // this eth_call.
  console.log("\n--dry-run: simulating handleOps with the prefund overridden");
  try {
    await publicClient.simulateContract({
      address: entryPoint, abi: EntryPointAbi, functionName: "handleOps",
      args: [[op], sponsor.address], account: sponsor,
      stateOverride: [{ address: op.sender, balance: deposit * 10n }]
    });
    console.log("simulation passed — the operation is publishable");
  } catch (error) {
    // FailedOp is a custom error, so it only decodes against the EntryPoint ABI;
    // without it a client reports nothing more useful than "reverted".
    const revertData = error.walk?.(e => typeof e?.data === "string")?.data ?? error.data;
    let detail = error.shortMessage ?? error.message;
    if (typeof revertData === "string" && revertData.startsWith("0x") && revertData.length > 10) {
      try {
        const decoded = decodeErrorResult({ abi: EntryPointAbi, data: revertData });
        detail = `${decoded.errorName}(${decoded.args.join(", ")})`;
      } catch {
        detail = `${detail} (undecodable revert ${revertData.slice(0, 18)}…)`;
      }
    }
    console.log(`simulation reverted: ${detail}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

if (selfFunded) {
  // Refuse early rather than burning a transaction: without a deposit the
  // account must cover the prefund itself, and the EntryPoint computes that
  // from the limits the signature already committed to.
  const required = (BigInt(op.preVerificationGas) + accountGasLimitsTotal(op)) * maxFeePerGas(op);
  const balance = await publicClient.getBalance({ address: op.sender });
  console.log(`\n==> self-funded: account balance ${formatEther(balance)} ETH, needs ${formatEther(required)} ETH`);
  if (balance < required) {
    throw new Error(
      `account ${op.sender} holds ${formatEther(balance)} ETH but the operation can cost up to ` +
      `${formatEther(required)} ETH. Send at least that much to the account, or drop --no-deposit ` +
      `to sponsor it instead.`
    );
  }
} else {
  console.log("\n==> depositTo");
  const depositTx = await wallet.writeContract({
    address: entryPoint, abi: EntryPointAbi, functionName: "depositTo", args: [op.sender], value: deposit
  });
  console.log(`    ${depositTx}`);
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
}

console.log("==> handleOps (sovereign publication)");
const opTx = await wallet.writeContract({
  address: entryPoint, abi: EntryPointAbi, functionName: "handleOps", args: [[op], sponsor.address]
});
console.log(`    ${opTx}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: opTx });
console.log(`    status=${receipt.status} gasUsed=${receipt.gasUsed}`);

const code = await publicClient.getCode({ address: op.sender });
const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
console.log(`\naccount code ${size}B — ${size > 0 ? "deployed" : "STILL COUNTERFACTUAL (deployment did not take effect)"}`);
if (size === 0) process.exit(1);
