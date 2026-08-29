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
//     --rpc-url <url> [--port 8787]

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, encodeAbiParameters, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { EntryPointAbi, packUserOperation } from "@loom/core";
import {
  authenticateSponsorRequest,
  createSponsorUsageLedger,
  parseAuthorizationRequest,
  parseActivationRequest,
  sponsorPolicyFromEnv
} from "./sponsor-policy.mjs";

// Runnable on its own, so it reads .env itself rather than relying on dev.mjs.
const envFile = join(dirname(fileURLToPath(import.meta.url)), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const argv = process.argv.slice(2);
const flag = name => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const rpcUrl = flag("rpc-url") ?? process.env.SEPOLIA_RPC_URL;
const privateRpcUrl = process.env.SPONSOR_PRIVATE_RPC_URL;
const port = Number(flag("port") ?? process.env.SPONSOR_PORT ?? 8787);
const entryPoint = flag("entry-point") ?? "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
const key = process.env.SEPOLIA_SPONSOR_PRIVATE_KEY;
const authorizerKey = process.env.SPONSOR_AUTHORIZER_PRIVATE_KEY;
// Must match the origin the wallet page is served from (dev.mjs defaults to 5174).
const allowedOrigin = process.env.SPONSOR_ALLOWED_ORIGIN ?? "http://localhost:5174";
const host = process.env.SPONSOR_HOST ?? "127.0.0.1";

if (!rpcUrl) throw new Error("--rpc-url or SEPOLIA_RPC_URL is required");
if (!privateRpcUrl) throw new Error("SPONSOR_PRIVATE_RPC_URL is required for private activation submission");
if (privateRpcUrl === rpcUrl) throw new Error("SPONSOR_PRIVATE_RPC_URL must be distinct from the public read RPC");
if (!key) throw new Error("SEPOLIA_SPONSOR_PRIVATE_KEY is required (never pass the key in argv)");
if (!authorizerKey || !/^0x[0-9a-fA-F]{64}$/.test(authorizerKey)) throw new Error("SPONSOR_AUTHORIZER_PRIVATE_KEY is required and must be 32-byte hex");
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
const authorizer = privateKeyToAccount(authorizerKey);
const wallet = createWalletClient({ account: sponsor, chain: sepolia, transport: http(privateRpcUrl) });
const sponsorPolicy = sponsorPolicyFromEnv(process.env, {
  host,
  chainId: sepolia.id,
  entryPoint,
  allowedOrigin
});
const sponsorUsage = createSponsorUsageLedger(sponsorPolicy);
const packedUserOperationComponents = [
  { name: "sender", type: "address" }, { name: "nonce", type: "uint256" },
  { name: "initCode", type: "bytes" }, { name: "callData", type: "bytes" },
  { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
  { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" },
  { name: "signature", type: "bytes" }
];
const onboardingPaymasterAbi = [{
  type: "function", name: "authorizationHash", stateMutability: "view",
  inputs: [{ name: "userOp", type: "tuple", components: packedUserOperationComponents },
  { name: "validUntil", type: "uint48" }, { name: "validAfter", type: "uint48" },
  { name: "costLimit", type: "uint256" }], outputs: [{ type: "bytes32" }]
}, ...["entryPoint", "authorizer", "factory", "policyHash", "maximumCost"].map(name => ({
  type: "function", name, stateMutability: "view", inputs: [],
  outputs: [{ type: name === "policyHash" ? "bytes32" : name === "maximumCost" ? "uint256" : "address" }]
}))];

const [liveEntryPoint, liveAuthorizer, liveFactory, livePolicyHash, liveMaximumCost] = await Promise.all(
  ["entryPoint", "authorizer", "factory", "policyHash", "maximumCost"].map(functionName => publicClient.readContract({
    address: sponsorPolicy.paymaster, abi: onboardingPaymasterAbi, functionName
  }))
);
if (String(liveEntryPoint).toLowerCase() !== entryPoint.toLowerCase()
  || String(liveAuthorizer).toLowerCase() !== authorizer.address.toLowerCase()
  || String(liveFactory).toLowerCase() !== sponsorPolicy.factory.toLowerCase()
  || String(livePolicyHash).toLowerCase() !== sponsorPolicy.policyHash.toLowerCase()
  || BigInt(liveMaximumCost) !== sponsorPolicy.maxCostWei) {
  throw new Error("live onboarding paymaster does not match the configured sponsor policy");
}

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
    } catch {
      // Undecodable revert data falls through to the provider's safe message.
    }
  }
  return error.shortMessage ?? error.message;
}

class ExplicitSponsorRejection extends Error {}
class DeliveryUnknown extends Error {}

async function submitPrivately(packed) {
  const existing = await publicClient.getCode({ address: packed.sender });
  if (existing && existing !== "0x") throw new ExplicitSponsorRejection("account is already deployed; reconcile its live chain state");

  // The paymaster's EntryPoint deposit is charged in the same operation. There
  // is no sender prefund transaction to strand or repeat.
  try {
    await publicClient.simulateContract({
      address: entryPoint, abi: EntryPointAbi, functionName: "handleOps",
      args: [[packed], sponsor.address], account: sponsor
    });
  } catch (error) {
    throw new ExplicitSponsorRejection(`operation would revert, not sponsoring: ${revertDetail(error)}`);
  }

  let opTx;
  try {
    opTx = await wallet.writeContract({
      address: entryPoint, abi: EntryPointAbi, functionName: "handleOps", args: [[packed], sponsor.address]
    });
  } catch (error) {
    throw new DeliveryUnknown(`private submission result is unknown: ${revertDetail(error)}`);
  }
  let receipt;
  try { receipt = await publicClient.waitForTransactionReceipt({ hash: opTx }); }
  catch (error) { throw new DeliveryUnknown(`private transaction ${opTx} was submitted but receipt lookup failed`); }

  let code;
  try { code = await publicClient.getCode({ address: packed.sender }); }
  catch { throw new DeliveryUnknown(`private transaction ${opTx} landed but account code verification failed`); }
  const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  if (size === 0) throw new DeliveryUnknown(`handleOps landed (${opTx}) but the account has no code`);

  return {
    account: packed.sender, opTx, codeSize: size,
    gasUsed: receipt.gasUsed.toString(), fundedBy: "sponsor"
  };
}

const server = createServer((req, res) => {
  // This is development infrastructure, but it still fail-closes to one
  // configured browser origin. Production operators should authenticate and
  // rate-limit before exposing any funded relay.
  //
  // The origin must be present, not merely non-conflicting. Skipping the check
  // when the header is absent left the gate applying only to browsers -- the one
  // client class that a browser's own CORS already constrains -- while `curl` and
  // every other script walked past it. A funded relay that pays whoever asks
  // should refuse the callers it cannot identify, and a cross-origin `fetch`
  // always sends `Origin`, so the wallet page is unaffected.
  const origin = req.headers.origin;
  if (origin !== allowedOrigin) {
    return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "origin not allowed" }));
  }
  if (origin === allowedOrigin) res.setHeader("access-control-allow-origin", allowedOrigin);
  if (origin === allowedOrigin) res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if (req.method === "POST" && req.url === "/v1/authorize") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 100_000) req.destroy(); });
    return void req.on("end", () => {
      serialize(async () => {
        let reservation;
        try {
          const principal = authenticateSponsorRequest(req.headers, sponsorPolicy);
          const parsed = parseAuthorizationRequest(JSON.parse(body), sponsorPolicy);
          // Reserve the full on-chain policy cap before issuing a reusable
          // authorization. A caller can submit it without returning here.
          const held = sponsorUsage.reserve({
            principal, userOpHash: parsed.userOpHash, maximumCost: sponsorPolicy.maxCostWei
          });
          if (held.duplicate) {
            return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(held.result));
          }
          reservation = held.reservation;
          const validAfter = 0n;
          const validUntil = BigInt(Math.floor(Date.now() / 1000) + 300);
          const costLimit = sponsorPolicy.maxCostWei;
          const placeholderData = encodeAbiParameters(
            [{ type: "uint48" }, { type: "uint48" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes" }],
            [validUntil, validAfter, costLimit, sponsorPolicy.policyHash, "0x"]
          );
          const sponsored = {
            ...parsed.op,
            preVerificationGas: parsed.op.preVerificationGas + sponsorPolicy.preVerificationGasBuffer,
            paymaster: sponsorPolicy.paymaster,
            paymasterVerificationGasLimit: sponsorPolicy.paymasterVerificationGasLimit,
            paymasterPostOpGasLimit: sponsorPolicy.paymasterPostOpGasLimit,
            paymasterData: placeholderData
          };
          const packed = packUserOperation(sponsored);
          const authorizationHash = await publicClient.readContract({
            address: sponsorPolicy.paymaster, abi: onboardingPaymasterAbi,
            functionName: "authorizationHash", args: [packed, validUntil, validAfter, costLimit]
          });
          const signature = await authorizer.sign({ hash: authorizationHash });
          const paymasterData = encodeAbiParameters(
            [{ type: "uint48" }, { type: "uint48" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes" }],
            [validUntil, validAfter, costLimit, sponsorPolicy.policyHash, signature]
          );
          const result = Object.freeze({
            authorized: true,
            paymaster: sponsorPolicy.paymaster,
            paymasterVerificationGasLimit: rpcQuantity(sponsorPolicy.paymasterVerificationGasLimit),
            paymasterPostOpGasLimit: rpcQuantity(sponsorPolicy.paymasterPostOpGasLimit),
            preVerificationGas: rpcQuantity(sponsored.preVerificationGas),
            paymasterData,
            validUntil: Number(validUntil)
          });
          sponsorUsage.commit(parsed.userOpHash, result);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch (error) {
          if (reservation) sponsorUsage.release(reservation);
          res.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({
            authorized: false, reason: error instanceof Error ? error.message : "authorization rejected"
          }));
        }
      });
    });
  }

  // Production-shaped, activation-only private submission. Unlike the legacy
  // development routes below, this boundary requires a deployment policy,
  // exact idempotency, a bounded principal budget, and an operation that can do
  // nothing except deploy its own counterfactual Loom account.
  if (req.method === "POST" && req.url === "/v1/activate") {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100_000) req.destroy();
    });
    return void req.on("end", () => {
      serialize(async () => {
        try {
          authenticateSponsorRequest(req.headers, sponsorPolicy);
          const parsed = parseActivationRequest(JSON.parse(body), sponsorPolicy);
          if (req.headers["idempotency-key"]?.toLowerCase() !== parsed.userOpHash.toLowerCase()) {
            throw new Error("idempotency key must equal the UserOperation hash");
          }
          const deployed = await submitPrivately(parsed.packed);
          const result = Object.freeze({
            accepted: true,
            account: parsed.op.sender,
            userOpHash: parsed.userOpHash,
            transactionHash: deployed.opTx,
            fundedBy: deployed.fundedBy
          });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "sponsor rejected the activation";
          // At this outer boundary we cannot prove that an RPC failure after
          // submission means non-acceptance. Only policy/auth/idempotency errors
          // are explicit pre-delivery rejections; all other failures are
          // delivery-ambiguous and must not trigger automatic public fallback.
          const policyRejected = !(error instanceof DeliveryUnknown);
          res.writeHead(policyRejected ? 422 : 502, { "content-type": "application/json" }).end(JSON.stringify({
            accepted: false,
            delivery: policyRejected ? "not-accepted" : "unknown",
            publicFallbackAllowed: policyRejected,
            reason
          }));
        }
      });
    });
  }

  // The former generic /deploy route intentionally no longer exists. It
  // bypassed the activation policy ledger and made the bounded /v1/activate
  // endpoint cosmetic. Self-funded creation belongs on a normal ERC-4337
  // bundler; sponsored creation must cross the policy boundary above.
  return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({
    error: "supported routes: POST /v1/authorize and POST /v1/activate"
  }));
});

function rpcQuantity(value) { return `0x${BigInt(value).toString(16)}`; }

// Loopback only. The reference process intentionally cannot be made into a
// network service by changing one environment variable: its in-memory ledger
// has no durable per-user identity or cross-instance transaction boundary.
server.listen(port, host, async () => {
  console.log(`sponsor  ${sponsor.address}`);
  console.log(`balance  ${formatEther(await publicClient.getBalance({ address: sponsor.address }))} ETH`);
  console.log(`funding  ERC-4337 onboarding paymaster deposit`);
  console.log(`authorization endpoint http://${host}:${port}/v1/authorize`);
  console.log(`activation endpoint http://${host}:${port}/v1/activate`);
  console.log(`accepting requests from origin ${allowedOrigin} only`);
  console.log(`policy    ${sponsorPolicy.policyId}; factory ${sponsorPolicy.factory}`);
  console.log(`paymaster ${sponsorPolicy.paymaster}; private submission RPC configured`);
  console.log("authentication loopback-development principal only; external production gateways are separate deployments");
});
