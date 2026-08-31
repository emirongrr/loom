import type { Address, Hex } from "@loom/core";

/**
 * Whether the key on this device still controls the account.
 *
 * A passkey assertion proves possession of the saved key, not that the account
 * still accepts it. Reading a balance is permissionless, but entering signer
 * mode must additionally check the live validator and its exact key binding.
 *
 * The account and validator settle it together: the validator must still be
 * installed and must still hold this credential's complete key binding.
 */
export type AccountControl =
  /** The validator this device signs with is installed on the account. */
  | { readonly kind: "in-control" }
  /**
   * The account was recovered. Its validators were replaced, so this device's
   * key signs against something the account no longer has.
   */
  | { readonly kind: "superseded" }
  /** The account could not be asked. Not knowing is not the same as being told. */
  | { readonly kind: "unreadable" };

const VALIDATOR_MODULE_TYPE = 1n;

export async function readAccountControl(input: {
  readonly account: Address;
  readonly validator: Address;
  readonly publicKey: { readonly x: Hex; readonly y: Hex; readonly rpIdHash: Hex; readonly originHash: Hex };
  readonly deployed: boolean;
  readonly isModuleInstalled: (input: {
    readonly account: Address;
    readonly moduleTypeId: bigint;
    readonly module: Address;
  }) => Promise<boolean>;
  readonly readPublicKey: (input: { readonly account: Address; readonly validator: Address }) => Promise<
    readonly [Hex, Hex, Hex, Hex]
  >;
}): Promise<AccountControl> {
  // An account with no code has installed nothing yet; its first operation
  // creates it with the validator this device holds. That is not supersession.
  if (!input.deployed) return Object.freeze({ kind: "in-control" as const });
  try {
    const installed = await input.isModuleInstalled({
      account: input.account,
      moduleTypeId: VALIDATOR_MODULE_TYPE,
      module: input.validator
    });
    if (!installed) return Object.freeze({ kind: "superseded" as const });
    const live = await input.readPublicKey({ account: input.account, validator: input.validator });
    const expected = input.publicKey;
    const sameKey = live[0].toLowerCase() === expected.x.toLowerCase()
      && live[1].toLowerCase() === expected.y.toLowerCase()
      && live[2].toLowerCase() === expected.rpIdHash.toLowerCase()
      && live[3].toLowerCase() === expected.originHash.toLowerCase();
    return Object.freeze({ kind: sameKey ? "in-control" as const : "superseded" as const });
  } catch {
    return Object.freeze({ kind: "unreadable" as const });
  }
}

/** What to tell the owner, in terms of what they can still do. */
export function describeAccountControl(control: AccountControl): {
  readonly title: string;
  readonly detail: string;
} | null {
  if (control.kind === "in-control") return null;
  if (control.kind === "unreadable") {
    return Object.freeze({
      title: "This account could not be checked",
      detail: "Whether this device's key still controls it is unknown until the account can be read. Sending may fail."
    });
  }
  return Object.freeze({
    title: "This account has been recovered",
    detail: "Its validators were replaced, so the passkey on this device no longer controls it and cannot sign."
      + " The account is not lost: whoever completed the recovery holds the key that does. Open it with that"
      + " passkey, or remove this stale entry."
  });
}
