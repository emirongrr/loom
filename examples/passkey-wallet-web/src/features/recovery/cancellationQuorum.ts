/**
 * How many people it takes to cancel a recovery, said once.
 *
 * ADR-0023: the account plus one fewer than the guardian threshold, or the
 * full threshold of guardians without the account. The account is never enough
 * alone -- if it were, whoever held a stolen key could block the guardians
 * trying to take the account back.
 *
 * At a threshold of one the two routes collapse: the account route asks for
 * the same single guardian and the account besides, so describing both would
 * present one outcome as two and steer the reader to the harder of them.
 *
 * This lives in one place because it was written twice and was wrong twice,
 * printing "1 guardians" in the wallet's warning and again in the guardian's
 * publish sheet.
 */
export function cancellationQuorum(threshold: number): {
  readonly collapsed: boolean;
  readonly withAccount: number;
  readonly guardiansOnly: number;
  readonly sentence: string;
} {
  const guardiansOnly = Math.max(1, Math.trunc(threshold));
  if (guardiansOnly <= 1) {
    return Object.freeze({
      collapsed: true,
      withAccount: 1,
      guardiansOnly: 1,
      sentence: "it takes 1 guardian, with or without this wallet"
    });
  }
  const withAccount = guardiansOnly - 1;
  return Object.freeze({
    collapsed: false,
    withAccount,
    guardiansOnly,
    sentence: `it needs this wallet plus ${count(withAccount)}, or ${count(guardiansOnly)} without this wallet`
  });
}

const count = (value: number): string => `${value} guardian${value === 1 ? "" : "s"}`;
