import { decodeAbiParameters, decodeFunctionData, formatEther, keccak256, stringToHex } from "viem";
import { EntryPointAbi, LoomAccountAbi } from "@loom/core/abi";
import type { Address, Hex } from "@loom/core";
import type { WalletDeployment } from "../onboarding/accountLifecycle";

/**
 * What this account actually did, read from the EntryPoint rather than a
 * transaction index.
 *
 * A Loom account never appears as the sender of a transaction. Its work travels
 * as a user operation inside someone else's `handleOps` call, so a block
 * explorer's history for the account is empty or shows only plain transfers
 * sent to it -- the recovery it published, the guardian change it scheduled,
 * every payment it made are all absent. The account looks idle while being
 * used.
 *
 * The EntryPoint knows. It emits `UserOperationEvent` for every operation, keyed
 * by sender, including whether the inner call succeeded and what the account
 * paid. That is the account's real history, and it needs no indexer: it is
 * `eth_getLogs` against one contract.
 *
 * Nothing here is authority. It reports what the chain logged, and a failed
 * operation is reported as failed rather than hidden -- the EntryPoint charges
 * for those too, which is exactly the case a reader needs to see.
 */
export interface AccountOperation {
  readonly userOpHash: Hex;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly nonce: bigint;
  /** False when the account's own call reverted. The fee was still paid. */
  readonly succeeded: boolean;
  readonly feePaid: bigint;
  /** What the operation did, as far as the calldata can be read. */
  readonly action: OperationAction;
}

export type OperationAction =
  | { readonly kind: "call"; readonly target: Address; readonly value: bigint; readonly selector: Hex; readonly label: string }
  | { readonly kind: "batch"; readonly count: number }
  /** The operation deployed this account. */
  | { readonly kind: "deployment" }
  | { readonly kind: "unreadable"; readonly reason: string };

const USER_OPERATION_EVENT = {
  type: "event",
  name: "UserOperationEvent",
  inputs: [
    { name: "userOpHash", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "paymaster", type: "address", indexed: true },
    { name: "nonce", type: "uint256", indexed: false },
    { name: "success", type: "bool", indexed: false },
    { name: "actualGasCost", type: "uint256", indexed: false },
    { name: "actualGasUsed", type: "uint256", indexed: false }
  ]
} as const;

/**
 * Name what a call did, from the deployment this wallet already trusts.
 *
 * Only contracts the manifest names are labelled. Anything else keeps its
 * address and selector: inventing a name for an unknown target would be the
 * one thing this must not do, since a reader checks history to find what they
 * did not expect.
 */
export function describeCall(input: {
  readonly target: Address;
  readonly selector: Hex;
  readonly deployment: WalletDeployment;
  readonly self: Address;
}): string {
  const known = new Map<string, string>();
  const add = (address: Address | undefined, name: string) => {
    if (address) known.set(address.toLowerCase(), name);
  };
  add(input.deployment.entryPoint, "EntryPoint");
  add(input.deployment.recoveryModule, "Recovery manager");
  add(input.deployment.recoveryIntentBoard, "Recovery board");
  add(input.deployment.recoveryValidatorProvisioner?.address, "Recovery validator factory");
  add(input.deployment.policyHook, "Policy hook");
  add(input.deployment.factory, "Account factory");
  add(input.self, "This account");

  const where = known.get(input.target.toLowerCase());
  const what: string | undefined = SELECTORS[input.selector.toLowerCase()];
  if (where && what) return `${where} · ${what}`;
  if (where) return where;
  if (what) return what;
  return "";
}

/** Selectors this wallet itself produces, so its own actions read as actions. */
const SELECTORS: Readonly<Partial<Record<string, string>>> = Object.freeze(Object.fromEntries([
  ["deploy(address,uint64,bytes32,bytes32,bytes32,bytes32,address,bytes32,uint8)", "published a recovery validator"],
  ["announce(address,address,bytes32,address,bytes32,bytes32,uint8,uint48)", "announced a recovery"],
  ["publishApproval(address,address,bytes32,address,bytes32,bytes32,uint8,(address,bytes32,bytes32,bytes,bytes32[])[])", "published a guardian approval"],
  ["proposeRecovery(address,address[],address,bytes32,bytes32,uint8,(address,bytes32,bytes32,bytes,bytes32[])[])", "proposed a recovery"],
  ["executeRecovery(address,address[])", "executed a recovery"],
  ["scheduleCall(address,uint256,bytes,uint48)", "scheduled a call"],
  ["executeScheduled(address,uint256,bytes)", "ran a scheduled call"],
  ["depositTo(address)", "funded a deposit"]
].map(([signature, label]) => [keccak256(stringToHex(signature!)).slice(0, 10), label])));

/** Read one account's operations, newest first, over a bounded window. */
export async function readAccountOperations(input: {
  readonly publicClient: {
    getBlockNumber(): Promise<bigint>;
    getLogs(args: unknown): Promise<readonly Record<string, unknown>[]>;
    getTransaction(args: { hash: Hex }): Promise<{ input: Hex }>;
  };
  readonly account: Address;
  readonly deployment: WalletDeployment;
  readonly maxBlockRange?: bigint;
  readonly maxWindows?: number;
}): Promise<{ readonly operations: readonly AccountOperation[]; readonly complete: boolean; readonly scannedFromBlock: bigint }> {
  const windowSize = input.maxBlockRange ?? 45_000n;
  const windows = input.maxWindows ?? 4;
  let toBlock = await input.publicClient.getBlockNumber();
  let scannedFrom = toBlock;
  const found: AccountOperation[] = [];

  for (let window = 0; window < windows && toBlock > 0n; window += 1) {
    const fromBlock = toBlock > windowSize ? toBlock - windowSize : 0n;
    let logs: readonly Record<string, unknown>[];
    try {
      logs = await input.publicClient.getLogs({
        address: input.deployment.entryPoint,
        event: USER_OPERATION_EVENT,
        args: { sender: input.account },
        fromBlock,
        toBlock
      });
    } catch {
      // A refused window is not an empty history, and the caller is told.
      return Object.freeze({ operations: Object.freeze(found.reverse()), complete: false, scannedFromBlock: scannedFrom });
    }
    for (const log of logs) {
      const args = log.args as Record<string, unknown> | undefined;
      if (!args) continue;
      found.push(Object.freeze({
        userOpHash: args.userOpHash as Hex,
        transactionHash: log.transactionHash as Hex,
        blockNumber: (log.blockNumber as bigint | null) ?? 0n,
        nonce: args.nonce as bigint,
        succeeded: args.success === true,
        feePaid: args.actualGasCost as bigint,
        action: await readAction(input, log.transactionHash as Hex)
      }));
    }
    scannedFrom = fromBlock;
    if (fromBlock === 0n) return Object.freeze({ operations: Object.freeze(found.reverse()), complete: true, scannedFromBlock: 0n });
    toBlock = fromBlock - 1n;
  }
  return Object.freeze({ operations: Object.freeze(found.reverse()), complete: false, scannedFromBlock: scannedFrom });
}

async function readAction(
  input: Parameters<typeof readAccountOperations>[0],
  transactionHash: Hex
): Promise<OperationAction> {
  try {
    const transaction = await input.publicClient.getTransaction({ hash: transactionHash });
    const { functionName, args } = decodeFunctionData({ abi: EntryPointAbi, data: transaction.input });
    if (functionName !== "handleOps") return Object.freeze({ kind: "unreadable", reason: `submitted through ${functionName}` });
    const ops = (args as readonly unknown[])[0] as readonly { sender: Address; callData: Hex; initCode?: Hex; factory?: Address }[];
    const mine = ops.find(op => op.sender.toLowerCase() === input.account.toLowerCase());
    if (!mine) return Object.freeze({ kind: "unreadable", reason: "this account's operation was not in the bundle" });
    return decodeAccountCall(mine.callData, input);
  } catch (error) {
    return Object.freeze({ kind: "unreadable", reason: error instanceof Error ? error.message.slice(0, 120) : "the bundle could not be read" });
  }
}

function decodeAccountCall(
  callData: Hex,
  input: Parameters<typeof readAccountOperations>[0]
): OperationAction {
  try {
    const { functionName, args } = decodeFunctionData({ abi: LoomAccountAbi, data: callData });
    if (functionName !== "execute") return Object.freeze({ kind: "unreadable", reason: `account called ${functionName}` });
    const payload = (args as readonly unknown[])[1] as Hex;
    const [call] = decodeAbiParameters(
      [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
      payload
    ) as unknown as [[Address, bigint, Hex]];
    const [target, value, data] = call;
    if (data === "0x" && value === 0n && target.toLowerCase() === input.account.toLowerCase()) {
      return Object.freeze({ kind: "deployment" });
    }
    const selector = data.slice(0, 10) as Hex;
    return Object.freeze({
      kind: "call" as const,
      target,
      value,
      selector,
      label: describeCall({ target, selector, deployment: input.deployment, self: input.account })
    });
  } catch {
    // A batch encodes differently; saying how many is more honest than
    // presenting the first call as though it were the whole operation.
    return Object.freeze({ kind: "unreadable", reason: "the call could not be decoded, so it may be a batch" });
  }
}

/** One line a reader can act on, without needing the tuple behind it. */
export function summarizeOperation(operation: AccountOperation): string {
  const fee = `${formatEther(operation.feePaid)} ETH fee`;
  const outcome = operation.succeeded ? "" : " · reverted, and the fee was still paid";
  switch (operation.action.kind) {
    case "deployment": return `Account created · ${fee}${outcome}`;
    case "batch": return `${operation.action.count} calls · ${fee}${outcome}`;
    case "unreadable": return `Operation · ${fee}${outcome} · ${operation.action.reason}`;
    case "call": {
      const named = operation.action.label || `${operation.action.target.slice(0, 10)}… · ${operation.action.selector}`;
      const sent = operation.action.value > 0n ? ` · sent ${formatEther(operation.action.value)} ETH` : "";
      return `${named}${sent} · ${fee}${outcome}`;
    }
  }
}
