/**
 * How much of the native balance a Loom account can actually send.
 *
 * The account pays for its own operation out of the same balance it is sending
 * from: `validateUserOp` forwards the EntryPoint's `missingAccountFunds` from
 * the account. So offering "Max" as the whole balance offers an amount that
 * cannot pay for its own delivery — the send fails, or succeeds and leaves an
 * account with no way to ever transact again.
 */

/**
 * A deliberately generous ceiling for one native transfer, covering P-256
 * verification, the transfer call, and pre-verification with headroom.
 *
 * Being too generous only leaves a little unsent, which the user can send later.
 * Being too tight strands the account. The asymmetry decides the number.
 */
export const NATIVE_SEND_GAS_CEILING = 1_200_000n;

/** What Max must leave behind so the resulting operation can still be paid for. */
export function nativeSendReserve(input: { readonly maxFeePerGas: bigint }): bigint {
  const price = input.maxFeePerGas > 0n ? input.maxFeePerGas : 0n;
  return price * NATIVE_SEND_GAS_CEILING;
}

/**
 * The largest native amount worth offering.
 *
 * Returns zero rather than a negative or optimistic figure when the balance
 * cannot cover its own fee: there is no amount to send, and saying so is better
 * than pre-filling a value that is guaranteed to fail.
 */
export function nativeMaxAmount(input: { readonly balance: bigint; readonly maxFeePerGas: bigint }): bigint {
  const reserve = nativeSendReserve({ maxFeePerGas: input.maxFeePerGas });
  return input.balance > reserve ? input.balance - reserve : 0n;
}
