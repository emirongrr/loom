/**
 * The one rule both encrypted stores need for their device key, in one place.
 *
 * Each store kept its own copy of read-then-create-then-add, and each had the
 * same gap: two callers that both find the slot empty both generate a key. That
 * happens on first use with two writes in flight, and across two tabs on the
 * same origin, which is ordinary for a wallet.
 *
 * `add` refusing to overwrite is what makes the recovery safe rather than
 * destructive. The stored key is the one existing records are encrypted under,
 * so a loser that overwrote it would strand every record already written. The
 * loser adopts the stored key instead — and adopting it before returning is what
 * keeps the caller's encryption on the surviving key rather than the discarded
 * one.
 */
export interface DeviceKeySlot {
  read(): Promise<CryptoKey | undefined>;
  create(): Promise<CryptoKey>;
  /** Must refuse to overwrite an existing key, so a race is detectable. */
  add(key: CryptoKey): Promise<void>;
}

export async function resolveDeviceKey(slot: DeviceKeySlot): Promise<CryptoKey> {
  const existing = await slot.read();
  if (existing) return existing;
  const created = await slot.create();
  try {
    await slot.add(created);
    return created;
  } catch (cause) {
    const winner = await slot.read();
    if (!winner) throw new Error("device key could not be stored", { cause });
    return winner;
  }
}
