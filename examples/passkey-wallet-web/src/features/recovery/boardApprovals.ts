import { createRecoveryIntentBoardReader, type GuardianApprovalTuple } from "@loom/sdk/recovery";
import type { Address, Hex } from "@loom/core";

/**
 * Guardian approvals published on chain, for the person assembling a proposal.
 *
 * Collecting approvals by hand means every guardian has to send their response
 * to one device, and that device has to still exist when the last one arrives.
 * The board (ADR-0024) already lets a guardian publish their approval instead:
 * `publishApproval` emits the whole tuple -- verifier, key commitment, salt,
 * signature and proof -- so the approval lives on chain rather than in someone's
 * inbox. Nothing read the other end of it.
 *
 * A guardian who publishes pays gas and proves their approval to anyone
 * looking; a guardian who prefers to send it privately still can. Both arrive at
 * the same tuple, so a recovery can mix them freely.
 *
 * Nothing here is trusted. `proposeRecovery` reconstructs each leaf, checks its
 * proof against the account's live guardian root, and asks the verifier contract
 * about the signature, refusing the whole call if any approval fails. So an
 * approval read from a public log is exactly as safe as one handed over in
 * person, and a forged one costs its author gas and achieves nothing.
 */
export interface BoardApproval {
  readonly guardianLeaf: Hex;
  readonly approval: GuardianApprovalTuple;
  /** Whether the log is deep enough that a reorganisation is unlikely. */
  readonly confirmed: boolean;
}

export interface BoardApprovalScan {
  readonly approvals: readonly BoardApproval[];
  /** Set when the board could not be read; the private paths are unaffected. */
  readonly unavailable?: string;
}

/**
 * Read the approvals published for one recovery.
 *
 * Scoped by `recoveryId`, so approvals for a different recovery of the same
 * account -- an earlier attempt, or one someone else announced -- are not
 * counted toward this one.
 */
export async function readBoardApprovals(input: {
  readonly chainId: number;
  readonly account: Address;
  readonly board: Address;
  readonly recoveryManager: Address;
  readonly recoveryId: Hex;
  readonly logTransport: Parameters<typeof createRecoveryIntentBoardReader>[0]["logTransport"];
}): Promise<BoardApprovalScan> {
  try {
    const reader = createRecoveryIntentBoardReader({
      chainId: input.chainId,
      account: input.account,
      board: input.board,
      recoveryManager: input.recoveryManager,
      ...(input.logTransport ? { logTransport: input.logTransport } : {})
    });
    const snapshot = await reader.discover();
    const wanted = input.recoveryId.toLowerCase();
    const byLeaf = new Map<string, BoardApproval>();
    for (const entry of snapshot.approvals) {
      if (entry.recoveryId.toLowerCase() !== wanted) continue;
      // One guardian, one seat. A guardian who published twice contributes one
      // approval, and the earliest is kept because the reader already ordered
      // them that way.
      const key = entry.guardianLeaf.toLowerCase();
      if (byLeaf.has(key)) continue;
      byLeaf.set(key, Object.freeze({
        guardianLeaf: entry.guardianLeaf,
        approval: entry.approval,
        confirmed: entry.confirmed
      }));
    }
    return Object.freeze({ approvals: Object.freeze([...byLeaf.values()]) });
  } catch (error) {
    return Object.freeze({
      approvals: Object.freeze([]),
      unavailable: error instanceof Error
        ? error.message
        : "The recovery board could not be read."
    });
  }
}

/**
 * Everything gathered for one proposal, from both routes, counted once each.
 *
 * A guardian who published on chain and also sent their response privately is
 * still one guardian. `proposeRecovery` would refuse the duplicate anyway --
 * approvals must arrive in strictly increasing leaf order -- but refusing at
 * submission time would mean discovering it after the gas was spent.
 */
export function mergeApprovals(input: {
  readonly collected: readonly { readonly leaf: Hex; readonly approval: GuardianApprovalTuple }[];
  readonly published: readonly BoardApproval[];
}): readonly GuardianApprovalTuple[] {
  const byLeaf = new Map<string, GuardianApprovalTuple>();
  for (const entry of input.collected) byLeaf.set(entry.leaf.toLowerCase(), entry.approval);
  for (const entry of input.published) {
    const key = entry.guardianLeaf.toLowerCase();
    if (!byLeaf.has(key)) byLeaf.set(key, entry.approval);
  }
  return Object.freeze([...byLeaf.values()]);
}
