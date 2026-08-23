import { encodeFunctionData, type Hex } from "viem";
import { RecoveryIntentBoardAbi } from "@loom/core/abi";

/**
 * Whether the board actually deployed on this chain can accept a published
 * cancellation.
 *
 * A deployment made before `publishCancellation` existed has no such function.
 * Calling it reverts on selector dispatch, and the only thing the person sees
 * is the bundler refusing to estimate gas -- an error about gas, for a problem
 * that has nothing to do with gas. Asking the chain what the contract can do,
 * before offering to do it, is cheaper than explaining that afterwards.
 *
 * Checked by looking for the selector in the deployed runtime code, which is
 * where Solidity's dispatch table puts it. A contract that somehow contained
 * the bytes without the function would fail at the call instead, which is the
 * behaviour without this check -- so this can only ever remove a dead end,
 * never create one.
 */
export function selectorOf(functionName: "publishCancellation" | "publishApproval"): Hex {
  return encodeFunctionData({
    abi: RecoveryIntentBoardAbi,
    functionName,
    // Argument values are irrelevant: only the leading four bytes are read.
    args: functionName === "publishCancellation"
      ? ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", []]
      : [
        "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000",
        `0x${"00".repeat(32)}`, "0x0000000000000000000000000000000000000000", `0x${"00".repeat(32)}`,
        `0x${"00".repeat(32)}`, 0, []
      ]
  }).slice(0, 10) as Hex;
}

export function codeSupports(code: string | undefined, selector: Hex): boolean {
  if (typeof code !== "string" || code.length <= 2) return false;
  return code.toLowerCase().includes(selector.slice(2).toLowerCase());
}

export function boardSupportsCancellation(code: string | undefined): boolean {
  return codeSupports(code, selectorOf("publishCancellation"));
}
