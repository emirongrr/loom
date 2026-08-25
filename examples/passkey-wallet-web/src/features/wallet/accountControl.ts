import type { Address } from "@loom/core";

/**
 * Whether the key on this device still controls the account.
 *
 * Opening a wallet is a local act: the saved handle is unlocked with a passkey
 * assertion and nothing is asked of the chain. Reading a balance is a plain
 * chain read and works for anyone. So an account whose validators were replaced
 * by a completed recovery still opens here, still shows its balance, and fails
 * only at signing -- as `AA24 signature error`, from the bundler, which names
 * neither the recovery nor the key.
 *
 * The account itself settles it: the validator this device would sign with is
 * either installed on it or it is not.
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
  readonly deployed: boolean;
  readonly isModuleInstalled: (input: {
    readonly account: Address;
    readonly moduleTypeId: bigint;
    readonly module: Address;
  }) => Promise<boolean>;
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
    return Object.freeze({ kind: installed ? "in-control" as const : "superseded" as const });
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
