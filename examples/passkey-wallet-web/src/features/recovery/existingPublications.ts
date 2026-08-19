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
  /** The scan reached the start of the chain and found nothing. */
  | { readonly kind: "none" }
  /**
   * The scan ran out of budget first. Finding nothing in a bounded window is
   * not the same as nothing existing, and reporting it as "none" would be a
   * claim the scan never established.
   */
  | { readonly kind: "unknown"; readonly scannedFromBlock: bigint; readonly message: string }
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
 *
 * `complete` comes from the scan and is deliberately required. A bounded scan
 * that found nothing must not be reported as an empty history, and a bounded
 * scan that found one publication must not be reported as the whole history --
 * an earlier one may sit below the window. Neither claim can be made from
 * `published` alone, so the flag travels with it and the type refuses a caller
 * that drops it.
 *
 * `heldDrafts` is how many encrypted drafts this device holds for the account
 * that could not be opened. Telling a reader "this device holds none of them"
 * while the device holds several unreadable drafts sends them to buy another
 * passkey when the real problem is a draft worth looking at.
 */
export function classifyExistingPublications(input: {
  readonly published: readonly PublishedRecoveryValidator[];
  readonly restored?: Address;
  readonly complete: boolean;
  readonly scannedFromBlock?: bigint;
  readonly heldDrafts?: number;
  /** See `PublicationScan.consistent`. Absent is treated as consistent. */
  readonly consistent?: boolean;
}): ExistingPublications {
  const published = [...input.published].sort((left, right) =>
    left.blockNumber === right.blockNumber ? 0 : left.blockNumber < right.blockNumber ? -1 : 1
  );
  const scannedFrom = input.scannedFromBlock ?? 0n;
  // Endpoints that disagreed about what exists cannot support a "nothing is
  // here" claim, whatever the scan's reach was.
  const settled = input.complete && input.consistent !== false;

  if (published.length === 0) {
    if (settled) return Object.freeze({ kind: "none" as const });
    return Object.freeze({
      kind: "unknown" as const,
      scannedFromBlock: scannedFrom,
      message: `No recovery passkey was found for this account back to block ${scannedFrom}, but the log scan`
        + ` stopped before reaching the start of the chain. That is not proof none was published. An endpoint`
        + ` serving the full log history would settle it.`
    });
  }

  const restored = input.restored?.toLowerCase();
  const match = restored
    ? published.find(entry => entry.validator.toLowerCase() === restored)
    : undefined;

  if (match && published.length === 1 && settled) {
    return Object.freeze({ kind: "resumable" as const, validator: match.validator });
  }

  const orphans = published.filter(entry => entry.validator.toLowerCase() !== restored);

  if (orphans.length === 0) {
    // Everything found belongs to this device, and only the scan's reach is in
    // doubt. Saying so beats inventing an abandoned publication.
    return Object.freeze({
      kind: "orphaned" as const,
      published: Object.freeze(published),
      ...(match ? { resumable: match.validator } : {}),
      message: `This device holds the recovery passkey for the publication found on chain. The scan reached back`
        + ` to block ${scannedFrom} without covering the whole chain, so an earlier publication cannot be ruled`
        + ` out.`
    });
  }

  const plural = orphans.length === 1 ? "" : "s";
  const listed = orphans.map(entry => short(entry.validator)).join(", ");
  const bounded = (input.complete ? "" : ` The scan reached back only to block ${scannedFrom}, so there may be more.`)
    + (input.consistent === false
      ? ` Two reads of the same range disagreed about what exists, so this list is the union of both and may`
        + ` still be short. Check the account on an explorer before paying to publish another.`
      : "");
  const held = input.heldDrafts ?? 0;

  let message: string;
  if (match) {
    message = `${orphans.length} earlier recovery passkey${plural} were published for this account and cannot be`
      + ` continued from this device. Only the one this device holds can be proposed; the rest are abandoned,`
      + ` and the gas spent on them is not recoverable. Abandoned: ${listed}.${bounded}`;
  } else if (held > 0) {
    const draftPlural = held === 1 ? "" : "s";
    message = `${orphans.length} recovery passkey${plural} were already published for this account (${listed}).`
      + ` This device holds ${held} saved recovery draft${draftPlural} for it, but none could be opened and`
      + ` matched to a published validator -- so the passkey may still be on this device even though its draft`
      + ` is unreadable. Look at that before paying to publish another: only one recovery can ever be proposed`
      + ` for this account.${bounded}`;
  } else {
    message = `${orphans.length} recovery passkey${plural} were already published for this account (${listed}),`
      + ` and this device holds none of them. Creating another costs gas again, and only one recovery can ever`
      + ` be proposed for this account. Continue only if the earlier passkey is genuinely lost.${bounded}`;
  }

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
  /**
   * False when two passes over the same range disagreed about what exists.
   *
   * Measured, not hypothetical: on a pooled public endpoint, the identical
   * `eth_getLogs` call over one 45,000-block range returned one log 14 times
   * out of 20 and two logs the other 6. Nothing errored -- the short answers
   * came back as ordinary success. A single pass over such an endpoint is a
   * coin flip, and a warning built on one silently fails to appear.
   */
  readonly consistent: boolean;
}

export interface PublicationLogReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: unknown): Promise<readonly {
    readonly args?: Record<string, unknown>;
    readonly blockNumber?: bigint | null;
  }[]>;
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
  readonly publicClient: PublicationLogReader;
  /**
   * A second, independently operated endpoint. The wallet already refuses to
   * sign unless two endpoints agree about the deployment; a question whose
   * wrong answer costs the user gas deserves the same treatment.
   */
  readonly verificationClient?: PublicationLogReader;
  readonly factory: Address;
  readonly account: Address;
  readonly recoveryNonce: bigint;
  readonly maxBlockRange?: bigint;
  readonly maxWindows?: number;
}): Promise<PublicationScan> {
  const readers = [input.publicClient, ...(input.verificationClient ? [input.verificationClient] : [input.publicClient])];
  const passes = await Promise.all(readers.map(reader => scanOnce({ ...input, publicClient: reader })));

  // The union is the honest answer: a pass that missed a publication proves
  // nothing about it, while a pass that saw one proves it exists. Only the
  // union can grow, so a flaky endpoint can no longer hide a publication --
  // it can only fail to add one, which the consistency flag then reports.
  const merged = new Map<string, PublishedRecoveryValidator>();
  for (const pass of passes) {
    for (const entry of pass.published) merged.set(entry.validator.toLowerCase(), entry);
  }
  const consistent = passes.every(pass => pass.published.length === merged.size);

  return Object.freeze({
    published: Object.freeze([...merged.values()]),
    complete: passes.every(pass => pass.complete),
    scannedFromBlock: passes.reduce((high, pass) => pass.scannedFromBlock > high ? pass.scannedFromBlock : high, 0n),
    consistent
  });
}

async function scanOnce(input: {
  readonly publicClient: PublicationLogReader;
  readonly factory: Address;
  readonly account: Address;
  readonly recoveryNonce: bigint;
  readonly maxBlockRange?: bigint;
  readonly maxWindows?: number;
}): Promise<Omit<PublicationScan, "consistent">> {
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
