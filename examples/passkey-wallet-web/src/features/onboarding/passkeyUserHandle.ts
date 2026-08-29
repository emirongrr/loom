import type { Address, Hex } from "@loom/core";
import {
  createAccountHandle,
  decodePasskeyAccountLocator,
  encodePasskeyAccountLocator
} from "@loom/sdk/account-discovery";

export { createAccountHandle };

/** Web adapter for the SDK's canonical account-locator codec. */
export function encodeAccountUserHandle(chainId: number, factory: Address, accountHandle: Hex): Uint8Array {
  return encodePasskeyAccountLocator({ chainId, factory, accountHandle });
}

export function decodeAccountUserHandle(handle: ArrayBuffer | Uint8Array | null): {
  readonly accountHandle: Hex;
  readonly chainId: number;
  readonly factory: Address;
} | null {
  const locator = decodePasskeyAccountLocator(handle);
  if (!locator) return null;
  return Object.freeze({
    accountHandle: locator.accountHandle,
    chainId: locator.chainId,
    factory: locator.factory
  });
}
