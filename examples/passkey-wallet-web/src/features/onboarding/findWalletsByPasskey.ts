import { decodeEventLog, encodeEventTopics, keccak256, sha256, stringToHex, toHex } from "viem";
import { P256ValidatorAbi } from "@loom/core/abi";
import type { Address, Hex } from "@loom/core";
import { findAccountForAssertion, type KeyCandidate, type PasskeyAssertion } from "./passkeyDiscovery.ts";

/**
 * The accounts a passkey can open, read from the chain rather than remembered.
 *
 * Every Loom account publishes its public key when it installs its validator.
 * That is not a leak invented for this: it is how the validator checks a
 * signature at all. Reading those events back gives every account that could
 * belong to a passkey on this site, and the assertion says which one does.
 *
 * Only the keys committed to this relying party and origin are considered, so
 * a key belonging to another site's account is never a candidate -- narrowed
 * before a signature is checked, not after.
 */
export interface WalletDiscoveryResult {
  readonly found: KeyCandidate | null;
  /** Set when the search could not be completed; "none" would be a false claim. */
  readonly unavailable?: string;
  readonly candidatesScanned: number;
}

export interface LogReader {
  getLogs(request: {
    address: readonly Address[];
    fromBlock: bigint;
    toBlock: bigint;
    topics: readonly Hex[];
  }): Promise<readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: readonly Hex[];
  }[]>;
  getBlockNumber(): Promise<bigint>;
}

/** Public endpoints cap how wide a single log query may be. */
const WINDOW = 40_000n;
const MAX_WINDOWS = 40;

export async function findWalletsByPasskey(input: {
  /**
   * Every validator worth asking: the deployment's own, and each one a recovery
   * deployed. A recovered account's key is published by the validator its
   * recovery installed, so a search limited to the profile's address finds the
   * key the account had before it was recovered and misses the one controlling
   * it now.
   */
  readonly validators: readonly Address[];
  readonly assertion: PasskeyAssertion;
  readonly rpId: string;
  readonly origin: string;
  readonly reader: LogReader;
  readonly subtle?: SubtleCrypto;
}): Promise<WalletDiscoveryResult> {
  // The account committed to a hash of its relying party and origin, so the
  // same two hashes decide which published keys are even worth checking.
  const rpIdHash = sha256(stringToHex(input.rpId));
  const originHash = keccak256(stringToHex(input.origin));
  const topic = encodeEventTopics({ abi: P256ValidatorAbi, eventName: "KeySet" })[0] as Hex;

  const candidates: KeyCandidate[] = [];
  let scannedWindows = 0;
  try {
    const head = await input.reader.getBlockNumber();

    // One query when the endpoint will answer one. Measured against Sepolia:
    // the factory's announcements and the whole key history came back in two
    // requests and under half a second, where a windowed walk of the same
    // ground made forty and tripped the endpoint's rate limit.
    const collect = (logs: readonly { readonly address: Address; readonly data: Hex; readonly topics: readonly Hex[] }[]) => {
      for (const log of logs) {
        const decoded = decode(log);
        if (decoded) candidates.push(decoded);
      }
    };

    try {
      collect(await input.reader.getLogs({
        address: input.validators, fromBlock: 0n, toBlock: head, topics: [topic]
      }));
      scannedWindows = 1;
    } catch {
      // Endpoints that cap how wide a range may be are walked in windows. The
      // cap is the reason for the walk, so nothing here treats it as a failure.
      candidates.length = 0;
      for (let end = head; end > 0n && scannedWindows < MAX_WINDOWS; end -= WINDOW) {
        const from = end > WINDOW ? end - WINDOW + 1n : 0n;
        collect(await input.reader.getLogs({
          address: input.validators, fromBlock: from, toBlock: end, topics: [topic]
        }));
        scannedWindows += 1;
        if (from === 0n) break;
      }
    }
  } catch (cause) {
    return Object.freeze({
      found: null,
      candidatesScanned: candidates.length,
      unavailable: cause instanceof Error ? cause.message : "The chain could not be searched."
    });
  }

  // Not one key published, on the validator this wallet is configured against
  // and creates its accounts through. Either nobody has ever made an account
  // here -- in which case there is nothing to find and saying so costs nothing
  // -- or the endpoint is not showing its history. Reporting "no wallet" would
  // be a guess between the two, and wrong in the case that matters.
  if (candidates.length === 0) {
    return Object.freeze({
      found: null,
      candidatesScanned: 0,
      unavailable: "This endpoint returned no account history, so there is nothing to search. Try another RPC endpoint in Developer settings."
    });
  }

  const found = await findAccountForAssertion({
    candidates,
    assertion: input.assertion,
    rpIdHash,
    originHash,
    ...(input.subtle ? { subtle: input.subtle } : {})
  });
  return Object.freeze({ found, candidatesScanned: candidates.length });
}

function decode(log: { readonly address: Address; readonly data: Hex; readonly topics: readonly Hex[] }): KeyCandidate | null {
  try {
    const result = decodeEventLog({ abi: P256ValidatorAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (result.eventName !== "KeySet") return null;
    const args = result.args as unknown as {
      account: Address; x: Hex; y: Hex; rpIdHash: Hex; originHash: Hex;
    };
    return Object.freeze({
      account: args.account,
      // The contract that emitted it, which is the one holding this key.
      validator: log.address,
      x: toHex(BigInt(args.x), { size: 32 }),
      y: toHex(BigInt(args.y), { size: 32 }),
      rpIdHash: args.rpIdHash,
      originHash: args.originHash
    });
  } catch {
    // A log from a different or future validator is discarded, never shaped
    // into a candidate.
    return null;
  }
}
