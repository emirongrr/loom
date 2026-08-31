import type { Address, Hex } from "@loom/core";
import {
  computeUserOperationHash,
  applyPaymasterAuthorization,
  createPrivateFirstTransport,
  type LoomTransportAdapter,
  type UserOperationEnvelope,
  type UserOperationReceipt
} from "@loom/sdk";
import type { WalletDeployment } from "../onboarding/accountLifecycle";
import type { ActivationPlan } from "./activate";

export class ExplicitSponsorRejection extends Error {
  readonly safeToFallback = true;
}

export function validateSponsoredActivationEnvelope(input: {
  readonly envelope: UserOperationEnvelope;
  readonly account: Address;
  readonly plan: ActivationPlan;
  readonly deployment: WalletDeployment;
  readonly policy: NonNullable<NonNullable<WalletDeployment["onboarding"]>["sponsorship"]>;
}): void {
  const { envelope, account, plan, deployment, policy } = input;
  const op = envelope.userOperation;
  if (envelope.chainId !== deployment.chainId || envelope.account.toLowerCase() !== account.toLowerCase()
    || op.sender.toLowerCase() !== account.toLowerCase()) throw new Error("sponsored activation account binding is invalid");
  if (op.nonce !== 0n || op.callData !== "0x") throw new Error("sponsorship is limited to an empty first activation operation");
  if (op.factory?.toLowerCase() !== plan.factory.toLowerCase() || op.factoryData?.toLowerCase() !== plan.factoryData.toLowerCase()) {
    throw new Error("sponsored activation factory commitment is invalid");
  }
  if (op.paymaster?.toLowerCase() !== input.deployment.onboardingPaymaster?.toLowerCase() || !op.paymasterData) {
    throw new Error("activation sponsorship is not bound to the deployment paymaster");
  }
  if (op.signature === "0x") throw new Error("sponsored activation must already be signed by the account passkey");
  if (bytes(op.factoryData) > policy.maxFactoryDataBytes) throw new Error("sponsored activation factory data exceeds policy");
  const maximumCost = (
    op.callGasLimit + op.verificationGasLimit + op.preVerificationGas
      + (op.paymasterVerificationGasLimit ?? 0n) + (op.paymasterPostOpGasLimit ?? 0n)
  ) * op.maxFeePerGas;
  if (maximumCost > BigInt(policy.maxCostWei)) throw new Error("sponsored activation maximum cost exceeds policy");
}

export async function authorizeSponsoredActivation(input: {
  readonly endpoint: string;
  readonly envelope: UserOperationEnvelope;
  readonly deployment: WalletDeployment;
  readonly fetch?: typeof fetch;
}): Promise<UserOperationEnvelope> {
  const policy = input.deployment.onboarding?.sponsorship;
  const paymaster = input.deployment.onboardingPaymaster;
  if (!policy || input.deployment.onboarding?.activation !== "sponsored" || !paymaster) {
    throw new Error("deployment does not advertise a pinned onboarding paymaster");
  }
  const response = await (input.fetch ?? fetch)(new URL("v1/authorize", withSlash(input.endpoint)), {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      policyId: policy.policyId, policyHash: policy.policyHash, chainId: input.deployment.chainId,
      entryPoint: input.deployment.entryPoint, factory: input.deployment.factory, paymaster,
      userOperation: rpcUserOperation(input.envelope.userOperation)
    })
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || body?.authorized !== true) throw new ExplicitSponsorRejection(String(body?.reason ?? "sponsor authorization was refused"));
  if (String(body.paymaster).toLowerCase() !== paymaster.toLowerCase()) throw new Error("sponsor authorized another paymaster");
  const paymasterData = String(body.paymasterData) as Hex;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/u.test(paymasterData)) throw new Error("sponsor returned invalid paymaster data");
  return applyPaymasterAuthorization(input.envelope, {
    preVerificationGas: parseQuantity(body.preVerificationGas, "sponsored pre-verification gas"),
    paymaster,
    paymasterVerificationGasLimit: parseQuantity(body.paymasterVerificationGasLimit, "paymaster verification gas"),
    paymasterPostOpGasLimit: parseQuantity(body.paymasterPostOpGasLimit, "paymaster post-op gas"),
    paymasterData
  });
}

export function createSponsoredActivationTransport(input: {
  readonly endpoint: string;
  readonly account: Address;
  readonly plan: ActivationPlan;
  readonly deployment: WalletDeployment;
  readonly publicTransport: LoomTransportAdapter;
  readonly fetch?: typeof fetch;
}): LoomTransportAdapter {
  const policy = input.deployment.onboarding?.sponsorship;
  if (!policy || input.deployment.onboarding?.activation !== "sponsored") throw new Error("deployment does not advertise sponsored onboarding");
  if (!input.deployment.onboardingPaymaster) throw new Error("deployment does not pin an onboarding paymaster");
  const endpoint = new URL("v1/activate", withSlash(input.endpoint)).toString();
  const request = input.fetch ?? fetch;
  const receipts = new Map<string, UserOperationReceipt>();
  const privateTransport: LoomTransportAdapter = {
    async sendUserOperation(envelope) {
      validateSponsoredActivationEnvelope({ envelope, account: input.account, plan: input.plan, deployment: input.deployment, policy });
      const userOpHash = computeUserOperationHash(envelope, { entryPoint: input.deployment.entryPoint });
      let response: Response;
      try {
        response = await request(endpoint, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "idempotency-key": userOpHash },
          body: JSON.stringify({
            policyId: policy.policyId,
            policyHash: policy.policyHash,
            chainId: input.deployment.chainId,
            entryPoint: input.deployment.entryPoint,
            factory: input.deployment.factory,
            paymaster: input.deployment.onboardingPaymaster,
            expectedUserOpHash: userOpHash,
            userOperation: rpcUserOperation(envelope.userOperation)
          })
        });
      } catch (cause) {
        throw new Error("private sponsor delivery is unknown; public fallback was not attempted", { cause });
      }
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || body?.accepted !== true) {
        if (body?.delivery === "not-accepted" && body?.publicFallbackAllowed === true) {
          throw new ExplicitSponsorRejection(String(body.reason ?? "sponsor explicitly rejected the activation"));
        }
        throw new Error(String(body?.reason ?? "private sponsor response was not verifiable"));
      }
      if (String(body.userOpHash).toLowerCase() !== userOpHash.toLowerCase()) throw new Error("private sponsor returned another UserOperation hash");
      if (String(body.account).toLowerCase() !== input.account.toLowerCase()) throw new Error("private sponsor returned another account");
      const transactionHash = String(body.transactionHash);
      if (!/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)) throw new Error("private sponsor returned an invalid transaction hash");
      const receipt = Object.freeze({
        userOpHash,
        sender: input.account,
        success: true,
        receipt: Object.freeze({ transactionHash: transactionHash as Hex })
      });
      receipts.set(userOpHash.toLowerCase(), receipt);
      return Object.freeze({ userOpHash, receipt });
    },
    async getUserOperationReceipt({ userOpHash }) { return receipts.get(userOpHash.toLowerCase()) ?? null; },
    async waitForUserOperationReceipt({ userOpHash }) {
      const receipt = receipts.get(userOpHash.toLowerCase());
      if (!receipt) throw new Error("private sponsor has no receipt for this activation");
      return receipt;
    }
  };
  return createPrivateFirstTransport({
    privateTransport,
    publicTransport: input.publicTransport,
    fallback: policy.publicFallback === "explicit-rejection" ? "explicit-rejection" : "never",
    ...(policy.publicFallback === "explicit-rejection"
      ? { isExplicitRejection: error => error instanceof ExplicitSponsorRejection }
      : {})
  });
}

function rpcUserOperation(op: UserOperationEnvelope["userOperation"]): Record<string, string> {
  return Object.freeze({
    sender: op.sender,
    nonce: quantity(op.nonce),
    ...(op.factory ? { factory: op.factory } : {}),
    ...(op.factoryData ? { factoryData: op.factoryData } : {}),
    callData: op.callData,
    callGasLimit: quantity(op.callGasLimit),
    verificationGasLimit: quantity(op.verificationGasLimit),
    preVerificationGas: quantity(op.preVerificationGas),
    maxFeePerGas: quantity(op.maxFeePerGas),
    maxPriorityFeePerGas: quantity(op.maxPriorityFeePerGas),
    ...(op.paymaster ? { paymaster: op.paymaster } : {}),
    ...(op.paymasterVerificationGasLimit !== undefined ? { paymasterVerificationGasLimit: quantity(op.paymasterVerificationGasLimit) } : {}),
    ...(op.paymasterPostOpGasLimit !== undefined ? { paymasterPostOpGasLimit: quantity(op.paymasterPostOpGasLimit) } : {}),
    ...(op.paymasterData ? { paymasterData: op.paymasterData } : {}),
    signature: op.signature
  });
}

function quantity(value: bigint): `0x${string}` { return `0x${value.toString(16)}`; }
function bytes(value?: string): number { return value ? (value.length - 2) / 2 : 0; }
function withSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) throw new Error(`${label} is invalid`);
  return BigInt(value);
}
