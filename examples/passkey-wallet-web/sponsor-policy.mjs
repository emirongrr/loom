import { decodeFunctionData, keccak256, stringToHex } from "viem";
import { getUserOpHash, LoomAccountFactoryAbi, packUserOperation } from "@loom/core";

export function parseAuthorizationRequest(body, policy) {
  return parseRequest(body, policy, false);
}

export function parseActivationRequest(body, policy) {
  return parseRequest(body, policy, true);
}

function parseRequest(body, policy, requirePaymaster) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body is invalid");
  if (body.policyId !== policy.policyId) throw new Error("sponsorship policy is not enabled");
  if (!same(body.policyHash, policy.policyHash)) throw new Error("sponsorship policy hash is invalid");
  if (body.chainId !== policy.chainId) throw new Error("sponsorship chain is invalid");
  if (!same(body.entryPoint, policy.entryPoint) || !same(body.factory, policy.factory) || !same(body.paymaster, policy.paymaster)) {
    throw new Error("sponsorship deployment binding is invalid");
  }
  const raw = body.userOperation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("user operation is required");
  const op = {
    sender: address(raw.sender, "sender"),
    nonce: quantity(raw.nonce, "nonce"),
    factory: address(raw.factory, "factory"),
    factoryData: hex(raw.factoryData, "factoryData"),
    callData: hex(raw.callData, "callData"),
    callGasLimit: quantity(raw.callGasLimit, "callGasLimit"),
    verificationGasLimit: quantity(raw.verificationGasLimit, "verificationGasLimit"),
    preVerificationGas: quantity(raw.preVerificationGas, "preVerificationGas"),
    maxFeePerGas: quantity(raw.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: quantity(raw.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    signature: hex(raw.signature, "signature"),
    ...(requirePaymaster ? {
      paymaster: address(raw.paymaster, "paymaster"),
      paymasterVerificationGasLimit: quantity(raw.paymasterVerificationGasLimit, "paymasterVerificationGasLimit"),
      paymasterPostOpGasLimit: quantity(raw.paymasterPostOpGasLimit, "paymasterPostOpGasLimit"),
      paymasterData: hex(raw.paymasterData, "paymasterData")
    } : {})
  };
  if (!requirePaymaster && (raw.paymaster !== undefined || raw.paymasterData !== undefined)) throw new Error("authorization request already carries a paymaster");
  if (requirePaymaster && !same(op.paymaster, policy.paymaster)) throw new Error("onboarding paymaster is not allowed");
  if (op.nonce !== 0n || op.callData !== "0x") throw new Error("only empty nonce-zero activation is sponsored");
  if (op.maxPriorityFeePerGas > op.maxFeePerGas) throw new Error("activation priority fee exceeds max fee");
  if (!same(op.factory, policy.factory)) throw new Error("activation factory is not allowed");
  if (byteLength(op.factoryData) > policy.maxFactoryDataBytes) throw new Error("factory data exceeds sponsorship policy");
  // The paymaster authorization hash deliberately excludes the account
  // signature, because paymaster data is attached before the account performs
  // its final WebAuthn signing ceremony. Final activation must carry it.
  if ((requirePaymaster && byteLength(op.signature) === 0) || byteLength(op.signature) > policy.maxSignatureBytes) {
    throw new Error("activation signature size is invalid");
  }
  const decoded = decodeFunctionData({ abi: LoomAccountFactoryAbi, data: op.factoryData });
  if (decoded.functionName !== "createAccount") throw new Error("only Loom account creation is sponsored");
  const maximumCost = (
    op.callGasLimit + op.verificationGasLimit + op.preVerificationGas
      + (op.paymasterVerificationGasLimit ?? 0n) + (op.paymasterPostOpGasLimit ?? 0n)
  ) * op.maxFeePerGas;
  if (maximumCost <= 0n || maximumCost > policy.maxCostWei) throw new Error("activation maximum cost exceeds sponsorship policy");
  const packed = packUserOperation(op);
  const userOpHash = getUserOpHash(packed, policy.entryPoint, BigInt(policy.chainId));
  if (requirePaymaster && !same(body.expectedUserOpHash, userOpHash)) throw new Error("activation UserOperation hash does not match");
  return Object.freeze({ op: Object.freeze(op), packed: Object.freeze(packed), userOpHash, maximumCost });
}

export function authenticateSponsorRequest(headers, policy) {
  void headers;
  if (policy.referenceLoopback !== true) throw new Error("reference sponsor authentication is unavailable");
  return "loopback-development";
}

export function createSponsorUsageLedger(policy, now = () => Date.now()) {
  const accepted = new Map();
  const idempotent = new Map();
  let globalReserved = 0n;
  return Object.freeze({
    reserve({ principal, userOpHash, maximumCost }) {
      const cached = idempotent.get(userOpHash.toLowerCase());
      if (cached) return Object.freeze({ duplicate: true, result: cached });
      const cutoff = now() - policy.windowSeconds * 1000;
      const history = (accepted.get(principal) ?? []).filter(item => item.at >= cutoff);
      if (history.length >= policy.maxActivationsPerPrincipal) throw new Error("principal activation quota exhausted");
      if (globalReserved + maximumCost > policy.maxGlobalCostWei) throw new Error("global sponsorship budget exhausted");
      const reservation = Object.freeze({ principal, userOpHash, maximumCost, at: now() });
      history.push(reservation);
      accepted.set(principal, history);
      globalReserved += maximumCost;
      return Object.freeze({ duplicate: false, reservation });
    },
    commit(userOpHash, result) { idempotent.set(userOpHash.toLowerCase(), Object.freeze(result)); },
    release(reservation) {
      const history = accepted.get(reservation.principal) ?? [];
      accepted.set(reservation.principal, history.filter(item => item !== reservation));
      globalReserved -= reservation.maximumCost;
    },
    snapshot() { return Object.freeze({ globalReserved, idempotent: idempotent.size }); }
  });
}

export function sponsorPolicyFromEnv(env, defaults) {
  const external = !["127.0.0.1", "localhost", "::1"].includes(defaults.host);
  if (external) {
    throw new Error("the reference sponsor is loopback-only; use an authenticated gateway with a durable shared ledger for external service");
  }
  const policyId = env.SPONSOR_POLICY_ID ?? "loom-sepolia-onboarding-v1";
  const policyHash = bytes32(env.SPONSOR_POLICY_HASH, "SPONSOR_POLICY_HASH");
  if (keccak256(stringToHex(policyId)).toLowerCase() !== policyHash.toLowerCase()) {
    throw new Error("SPONSOR_POLICY_HASH must be keccak256 of SPONSOR_POLICY_ID");
  }
  return Object.freeze({
    policyId,
    chainId: defaults.chainId,
    entryPoint: defaults.entryPoint,
    factory: address(env.SPONSOR_FACTORY, "SPONSOR_FACTORY"),
    paymaster: address(env.SPONSOR_PAYMASTER, "SPONSOR_PAYMASTER"),
    policyHash,
    paymasterVerificationGasLimit: positive(env.SPONSOR_PAYMASTER_VERIFICATION_GAS ?? "150000", "SPONSOR_PAYMASTER_VERIFICATION_GAS"),
    paymasterPostOpGasLimit: positive(env.SPONSOR_PAYMASTER_POSTOP_GAS ?? "1", "SPONSOR_PAYMASTER_POSTOP_GAS"),
    preVerificationGasBuffer: positive(env.SPONSOR_PRE_VERIFICATION_GAS_BUFFER ?? "50000", "SPONSOR_PRE_VERIFICATION_GAS_BUFFER"),
    allowedOrigin: defaults.allowedOrigin,
    referenceLoopback: true,
    maxCostWei: positive(env.SPONSOR_MAX_COST_WEI ?? "5000000000000000", "SPONSOR_MAX_COST_WEI"),
    maxGlobalCostWei: positive(env.SPONSOR_GLOBAL_BUDGET_WEI ?? "100000000000000000", "SPONSOR_GLOBAL_BUDGET_WEI"),
    maxFactoryDataBytes: bounded(env.SPONSOR_MAX_FACTORY_DATA_BYTES ?? "8192", 65_536, "SPONSOR_MAX_FACTORY_DATA_BYTES"),
    maxSignatureBytes: bounded(env.SPONSOR_MAX_SIGNATURE_BYTES ?? "4096", 16_384, "SPONSOR_MAX_SIGNATURE_BYTES"),
    maxActivationsPerPrincipal: bounded(env.SPONSOR_MAX_ACTIVATIONS_PER_PRINCIPAL ?? "3", 1_000, "SPONSOR_MAX_ACTIVATIONS_PER_PRINCIPAL"),
    windowSeconds: bounded(env.SPONSOR_WINDOW_SECONDS ?? "86400", 31_536_000, "SPONSOR_WINDOW_SECONDS")
  });
}

function address(value, label) { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new Error(`${label} is invalid`); return value; }
function bytes32(value, label) { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new Error(`${label} is invalid`); return value; }
function hex(value, label) { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) throw new Error(`${label} is invalid`); return value.toLowerCase(); }
function quantity(value, label) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) throw new Error(`${label} is invalid`); return BigInt(value); }
function positive(value, label) { const parsed = BigInt(value); if (parsed <= 0n) throw new Error(`${label} must be positive`); return parsed; }
function bounded(value, maximum, label) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${label} is invalid`); return parsed; }
function byteLength(value) { return (value.length - 2) / 2; }
function same(left, right) { return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase(); }
