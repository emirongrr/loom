import type { Address } from "@loom/core";

/**
 * Which saved wallets have a recovery under way, read from the chain.
 *
 * A recovery is started by whoever holds the guardians, on whatever device they
 * are using. The owner's own list said nothing about it until they opened the
 * wallet, so an account could be three days into a delay while its entry looked
 * ordinary -- and the delay exists precisely so an owner has time to object.
 */
export type WalletRecovery =
  /** Nothing pending, as the account itself reports. */
  | { readonly kind: "none" }
  /** A recovery is recorded and its delay has not elapsed. */
  | { readonly kind: "waiting"; readonly readyAt: bigint }
  /** Approved, matured, and executable by anyone now. */
  | { readonly kind: "executable"; readonly expiresAt: bigint }
  /** The account could not be asked. Silence is not the same as nothing. */
  | { readonly kind: "unreadable" };

export interface PendingRecoveryRecord {
  readonly pending: boolean;
  readonly readyAt: bigint;
  readonly expiresAt: bigint;
}

/**
 * Read once per account, and never allowed to fail together: an account that
 * cannot be reached must not decide what is shown about the others, and must
 * not be reported as having nothing pending.
 */
export async function readWalletsBeingRecovered(input: {
  readonly accounts: readonly { readonly id: string; readonly account: Address; readonly chainId: number }[];
  readonly chainId: number;
  readonly readPending: (account: Address) => Promise<PendingRecoveryRecord>;
  readonly nowSeconds: number;
}): Promise<ReadonlyMap<string, WalletRecovery>> {
  const scoped = input.accounts.filter(account => account.chainId === input.chainId);
  const entries = await Promise.all(scoped.map(async (account): Promise<readonly [string, WalletRecovery]> => {
    try {
      const record = await input.readPending(account.account);
      if (!record.pending || record.readyAt === 0n) return [account.id, { kind: "none" }];
      return [account.id, record.readyAt > BigInt(input.nowSeconds)
        ? { kind: "waiting", readyAt: record.readyAt }
        : { kind: "executable", expiresAt: record.expiresAt }];
    } catch {
      return [account.id, { kind: "unreadable" }];
    }
  }));
  return new Map(entries);
}

/** What the row says, in the words of what the owner can still do about it. */
export function describeWalletRecovery(recovery: WalletRecovery | undefined): {
  readonly label: string;
  readonly urgent: boolean;
  readonly detail: string;
} | null {
  if (!recovery || recovery.kind === "none") return null;
  if (recovery.kind === "unreadable") {
    return Object.freeze({
      label: "Not checked",
      urgent: false,
      detail: "Whether a recovery is under way could not be read for this wallet."
    });
  }
  if (recovery.kind === "waiting") {
    return Object.freeze({
      label: "Being recovered",
      urgent: true,
      detail: "Someone is recovering this wallet. The delay is what gives you time to stop it."
    });
  }
  return Object.freeze({
    label: "Recovery ready",
    urgent: true,
    detail: "The delay has passed, so this recovery can be completed by anyone at any moment."
  });
}
