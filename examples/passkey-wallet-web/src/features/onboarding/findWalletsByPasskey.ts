import { decodeEventLog, encodeEventTopics, keccak256, sha256, stringToHex, toHex } from "viem";
import { P256ValidatorAbi } from "@loom/core/abi";
import type { Address, Hex } from "@loom/core";
import { findAccountForAssertion, type KeyCandidate, type PasskeyAssertion } from "./passkeyDiscovery";

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
  getLogs(request: { address: Address; fromBlock: bigint; toBlock: bigint; topics: readonly Hex[] }): Promise<readonly {
    readonly data: Hex;
    readonly topics: readonly Hex[];
  }[]>;
  getBlockNumber(): Promise<bigint>;
}

/** Public endpoints cap how wide a single log query may be. */
const WINDOW = 40_000n;
const MAX_WINDOWS = 40;

export async function findWalletsByPasskey(input: {
  readonly validator: Address;
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
    for (let end = head; end > 0n && scannedWindows < MAX_WINDOWS; end -= WINDOW) {
      const from = end > WINDOW ? end - WINDOW + 1n : 0n;
      const logs = await input.reader.getLogs({ address: input.validator, fromBlock: from, toBlock: end, topics: [topic] });
      scannedWindows += 1;
      for (const log of logs) {
        const decoded = decode(log);
        if (decoded) candidates.push(decoded);
      }
      if (from === 0n) break;
    }
  } catch (cause) {
    return Object.freeze({
      found: null,
      candidatesScanned: candidates.length,
      unavailable: cause instanceof Error ? cause.message : "The chain could not be searched."
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

function decode(log: { readonly data: Hex; readonly topics: readonly Hex[] }): KeyCandidate | null {
  try {
    const result = decodeEventLog({ abi: P256ValidatorAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (result.eventName !== "KeySet") return null;
    const args = result.args as unknown as {
      account: Address; x: Hex; y: Hex; rpIdHash: Hex; originHash: Hex;
    };
    return Object.freeze({
      account: args.account,
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

/**
 * The accounts that published these keys, for guardians recorded before the
 * address was kept.
 *
 * A passkey guardian's descriptor holds the key, not the address it came from,
 * and the address cannot be derived from the key alone: it also depends on the
 * guardian root, threshold, configuration hash and recovery module of *that*
 * account, none of which this wallet knows. The chain does know, because the
 * account published the key when its validator was installed.
 *
 * Returns only what it found. An account whose key is not in the scanned range
 * is left out rather than guessed at, and the caller keeps showing what it had.
 */
export async function findAccountsByPublicKey(input: {
  readonly validator: Address;
  readonly keys: readonly { readonly x: Hex; readonly y: Hex }[];
  readonly reader: LogReader;
}): Promise<ReadonlyMap<string, Address>> {
  const wanted = new Set(input.keys.map(key => keyOf(key)));
  const found = new Map<string, Address>();
  if (wanted.size === 0) return found;

  const topic = encodeEventTopics({ abi: P256ValidatorAbi, eventName: "KeySet" })[0] as Hex;
  try {
    const head = await input.reader.getBlockNumber();
    for (let end = head, windows = 0; end > 0n && windows < MAX_WINDOWS && found.size < wanted.size; end -= WINDOW) {
      const from = end > WINDOW ? end - WINDOW + 1n : 0n;
      const logs = await input.reader.getLogs({ address: input.validator, fromBlock: from, toBlock: end, topics: [topic] });
      windows += 1;
      for (const log of logs) {
        const candidate = decode(log);
        if (!candidate) continue;
        const key = keyOf(candidate);
        if (wanted.has(key) && !found.has(key)) found.set(key, candidate.account);
      }
      if (from === 0n) break;
    }
  } catch {
    // Unreadable is not "no such account": the caller shows what it already
    // had rather than replacing it with a claim.
    return found;
  }
  return found;
}

export const publicKeyIndex = (key: { readonly x: Hex; readonly y: Hex }): string => keyOf(key);

const keyOf = (key: { readonly x: Hex; readonly y: Hex }): string => `${key.x.toLowerCase()}:${key.y.toLowerCase()}`;
