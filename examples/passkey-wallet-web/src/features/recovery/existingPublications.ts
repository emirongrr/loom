import type { Address, Hex } from "@loom/core";

/**
 * Recovery passkeys already published on chain for one account.
 *
 * Publishing a recovery validator is permissionless and costs gas, and the
 * wallet only ever looked for a *local* draft before offering to create another
 * passkey. A user whose draft was cleared, or who opened the flow in a second
 * browser profile, was quietly offered a fresh passkey and paid to publish a
 * second validator -- of which only one can ever be proposed, because the
 * recovery nonce admits a single pending request.
 *
 * The chain has always known better: the factory emits
 * `RecoveryValidatorDeployed(account, recoveryNonce, initDataHash, validator)`.
 * This turns that into something the interface can say out loud.
 *
 * It does not block. A publication whose passkey is genuinely lost is not
 * recoverable, and the way forward really is a new one; being told that is
 * different from being led into it unknowingly.
 */
export interface PublishedRecoveryValidator {
  readonly validator: Address;
  readonly initDataHash: Hex;
  readonly blockNumber: bigint;
}

export type ExistingPublications =
  | { readonly kind: "none" }
  /** One publication, and this device holds the passkey that made it. */
  | { readonly kind: "resumable"; readonly validator: Address }
  /** Publications exist that this device cannot continue. */
  | {
    readonly kind: "orphaned";
    readonly published: readonly PublishedRecoveryValidator[];
    readonly resumable?: Address;
    readonly message: string;
  };

const short = (value: string): string => `${value.slice(0, 10)}…${value.slice(-6)}`;

/**
 * What the chain says about this account's recovery publications, read against
 * what this device can actually continue.
 *
 * `restored` is the validator a local draft resolved to, when one did. A
 * publication matching it is the recovery in progress; anything else is a
 * passkey no longer reachable from here.
 */
export function classifyExistingPublications(input: {
  readonly published: readonly PublishedRecoveryValidator[];
  readonly restored?: Address;
}): ExistingPublications {
  const published = [...input.published].sort((left, right) =>
    left.blockNumber === right.blockNumber ? 0 : left.blockNumber < right.blockNumber ? -1 : 1
  );
  if (published.length === 0) return Object.freeze({ kind: "none" as const });

  const restored = input.restored?.toLowerCase();
  const match = restored
    ? published.find(entry => entry.validator.toLowerCase() === restored)
    : undefined;

  if (match && published.length === 1) {
    return Object.freeze({ kind: "resumable" as const, validator: match.validator });
  }

  const orphans = published.filter(entry => entry.validator.toLowerCase() !== restored);
  const plural = orphans.length === 1 ? "" : "s";
  const message = match
    ? `${orphans.length} earlier recovery passkey${plural} were published for this account and cannot be continued`
      + ` from this device. Only the one this device holds can be proposed; the rest are abandoned, and the gas`
      + ` spent on them is not recoverable. Abandoned: ${orphans.map(entry => short(entry.validator)).join(", ")}.`
    : `${orphans.length} recovery passkey${plural} were already published for this account`
      + ` (${orphans.map(entry => short(entry.validator)).join(", ")}), and this device holds none of them.`
      + ` Creating another costs gas again, and only one recovery can ever be proposed for this account.`
      + ` Continue only if the earlier passkey is genuinely lost.`;

  return Object.freeze({
    kind: "orphaned" as const,
    published: Object.freeze(published),
    ...(match ? { resumable: match.validator } : {}),
    message
  });
}

/** What a bounded log scan found, and whether it saw the whole history. */
export interface PublicationScan {
  readonly published: readonly PublishedRecoveryValidator[];
  /** False when the budget ran out before reaching `fromBlock`. */
  readonly complete: boolean;
  readonly scannedFromBlock: bigint;
}

/**
 * Read this account's recovery publications from the factory's own log.
 *
 * Public endpoints cap `eth_getLogs` ranges -- 50k blocks on the default
 * Sepolia node -- so an unbounded scan is refused outright. Asking for
 * `earliest` and swallowing the refusal is how this check silently did nothing
 * at all, which is worse than not having it: the interface would promise a
 * warning it could never give.
 *
 * So the scan is windowed and bounded, and it reports whether it finished. A
 * truncated scan says "nothing found in the last N blocks", never "nothing".
 */
export async function readPublishedRecoveryValidators(input: {
  readonly publicClient: {
    getBlockNumber(): Promise<bigint>;
    getLogs(args: unknown): Promise<readonly {
      readonly args?: Record<string, unknown>;
      readonly blockNumber?: bigint | null;
    }[]>;
  };
  readonly factory: Address;
  readonly account: Address;
  readonly recoveryNonce: bigint;
  readonly maxBlockRange?: bigint;
  readonly maxWindows?: number;
}): Promise<PublicationScan> {
  const windowSize = input.maxBlockRange ?? 45_000n;
  const windows = input.maxWindows ?? 8;
  const event = {
    type: "event",
    name: "RecoveryValidatorDeployed",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "recoveryNonce", type: "uint64", indexed: true },
      { name: "initDataHash", type: "bytes32", indexed: true },
      { name: "validator", type: "address", indexed: false }
    ]
  } as const;

  const found: PublishedRecoveryValidator[] = [];
  let toBlock: bigint;
  try {
    toBlock = await input.publicClient.getBlockNumber();
  } catch {
    return Object.freeze({ published: Object.freeze([]), complete: false, scannedFromBlock: 0n });
  }

  let scannedFrom = toBlock;
  for (let window = 0; window < windows && toBlock > 0n; window += 1) {
    const fromBlock = toBlock > windowSize ? toBlock - windowSize : 0n;
    try {
      const logs = await input.publicClient.getLogs({
        address: input.factory,
        event,
        args: { account: input.account, recoveryNonce: input.recoveryNonce },
        fromBlock,
        toBlock
      });
      for (const log of logs) {
        const validator = log.args?.validator;
        const initDataHash = log.args?.initDataHash;
        if (typeof validator !== "string" || typeof initDataHash !== "string") continue;
        found.push(Object.freeze({
          validator: validator as Address,
          initDataHash: initDataHash as Hex,
          blockNumber: log.blockNumber ?? 0n
        }));
      }
    } catch {
      // One refused window does not prove the history is empty.
      return Object.freeze({ published: Object.freeze(found), complete: false, scannedFromBlock: scannedFrom });
    }
    scannedFrom = fromBlock;
    if (fromBlock === 0n) return Object.freeze({ published: Object.freeze(found), complete: true, scannedFromBlock: 0n });
    toBlock = fromBlock - 1n;
  }
  return Object.freeze({ published: Object.freeze(found), complete: false, scannedFromBlock: scannedFrom });
}
