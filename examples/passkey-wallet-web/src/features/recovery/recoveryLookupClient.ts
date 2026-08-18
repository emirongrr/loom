import { LoomAccountAbi, RecoveryManagerAbi } from "@loom/core";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { classifyRecoveryLookup, type PendingRecoveryRecord, type RecoveryLookup } from "./recoveryLookup";

/**
 * Read a recovery from the chain for an account this device knows nothing about.
 *
 * Everything here is a view call. The result is what the manager and the account
 * say right now, read together so the caller is never shown a request that a
 * newer configuration has already invalidated.
 */
export interface RecoveryLookupResult {
  readonly account: Address;
  readonly recoveryManager: Address;
  readonly lookup: RecoveryLookup;
  readonly liveConfigVersion: bigint;
  readonly oldValidators: readonly Address[];
  readonly blockNumber: bigint;
  /** The chain's own clock, not the browser's: the manager compares against this. */
  readonly chainTimestamp: bigint;
}

export async function lookupRecovery(input: {
  readonly publicClient: PublicClient;
  readonly recoveryManager: Address;
  readonly account: Address;
}): Promise<RecoveryLookupResult> {
  const { publicClient, recoveryManager } = input;
  const account = getAddress(input.account);

  const code = await publicClient.getCode({ address: account });
  if (!code || code === "0x") throw new Error("This address has no account on chain, so it has no recovery state.");

  // A block timestamp, not `Date.now()`. The manager's delay and expiry are
  // compared against block time, and a browser clock that is minutes out would
  // report a request as executable when it is not, or the reverse.
  const block = await publicClient.getBlock({ blockTag: "latest" });

  const raw = await publicClient.readContract({
    address: recoveryManager,
    abi: RecoveryManagerAbi,
    functionName: "pendingRecoveries",
    args: [account]
  // `uint48` decodes to a number and `uint64` to a bigint, so widen the two
  // timestamps rather than assuming the whole tuple is one shape.
  }) as readonly [Hex, Address, Hex, Hex, number, number, number, bigint, bigint];

  const record: PendingRecoveryRecord = Object.freeze({
    oldValidatorsHash: raw[0],
    newValidator: raw[1],
    initDataHash: raw[2],
    newGuardianRoot: raw[3],
    newGuardianThreshold: Number(raw[4]),
    readyAt: BigInt(raw[5]),
    expiresAt: BigInt(raw[6]),
    configVersion: BigInt(raw[7]),
    nonce: BigInt(raw[8])
  });

  const liveConfigVersion = await publicClient.readContract({
    address: account, abi: LoomAccountAbi, functionName: "configVersion"
  }) as bigint;

  const count = await publicClient.readContract({
    address: account, abi: LoomAccountAbi, functionName: "validatorCount"
  }) as bigint;
  const oldValidators: Address[] = [];
  for (let index = 0n; index < count; index += 1n) {
    oldValidators.push(await publicClient.readContract({
      address: account, abi: LoomAccountAbi, functionName: "validatorAt", args: [index]
    }) as Address);
  }

  return Object.freeze({
    account,
    recoveryManager: getAddress(recoveryManager),
    lookup: classifyRecoveryLookup({
      record: record.readyAt === 0n ? null : record,
      liveConfigVersion,
      nowSeconds: block.timestamp
    }),
    liveConfigVersion,
    oldValidators: Object.freeze(oldValidators),
    blockNumber: block.number ?? 0n,
    chainTimestamp: block.timestamp
  });
}

/**
 * Encode the execution call.
 *
 * It takes no initializer: the validator was initialized when it was deployed
 * (ADR-0025), so a matured recovery can be finished by anyone with gas, from any
 * device.
 */
export function encodeExecuteRecovery(input: {
  readonly account: Address;
  readonly oldValidators: readonly Address[];
}) {
  return {
    abi: RecoveryManagerAbi,
    functionName: "executeRecovery" as const,
    args: [input.account, input.oldValidators.map(address => getAddress(address))] as const
  };
}
