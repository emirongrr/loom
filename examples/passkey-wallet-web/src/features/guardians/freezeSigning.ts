import type { Hex } from "@loom/core";
import { parseP256Signature } from "@loom/passkey";
import type { GuardianInviteV1 } from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256, sha256, stringToHex } from "viem";
import { signWithBrowserPasskey, type BrowserPasskeyAssertion, type PasskeySignRequest } from "../wallet/webauthn.ts";
import type { AccountHandle } from "../../types.ts";

export function guardianCapabilityMatchesAccount(capability: GuardianInviteV1, account: AccountHandle): boolean {
  if (capability.chainId !== account.chainId) return false;
  const commitment = capability.guardian.kind === "p256"
    ? keccak256(encodeAbiParameters(
        [{ type: "bytes32", name: "x" }, { type: "bytes32", name: "y" }],
        [account.publicKey.x, account.publicKey.y]
      ))
    : capability.guardian.kind === "erc1271"
      ? keccak256(encodeAbiParameters([{ type: "address" }], [account.account]))
      : null;
  if (!commitment) return false;
  return commitment.toLowerCase() === capability.guardian.keyCommitment.toLowerCase();
}

/** Ask the matching guardian passkey to authorize the exact live digest. */
export async function signGuardianDigestWithPasskey(input: {
  readonly capability: GuardianInviteV1;
  readonly account: AccountHandle;
  readonly digest: Hex;
  readonly signChallenge?: (request: PasskeySignRequest) => Promise<BrowserPasskeyAssertion>;
}): Promise<Hex> {
  if (!guardianCapabilityMatchesAccount(input.capability, input.account)) {
    throw new Error("The open wallet does not match this guardian capability.");
  }
  if (input.capability.guardian.kind === "erc1271") {
    throw new Error("This capability uses the Loom account address, but its P-256 validator intentionally rejects arbitrary ERC-1271 digests. The account owner must remove this guardian and add the same address again so its P-256 key is pinned directly.");
  }
  const assertion = await (input.signChallenge ?? signWithBrowserPasskey)({
    userOperationHash: input.digest,
    rpId: input.account.rpId,
    credentialId: input.account.credentialId
  });
  if (input.capability.guardian.kind === "p256") {
    const { r, s } = parseP256Signature(assertion.signature);
    return encodeAbiParameters(
      [{
        type: "tuple", components: [
          { name: "x", type: "bytes32" }, { name: "y", type: "bytes32" },
          { name: "rpIdHash", type: "bytes32" }, { name: "originHash", type: "bytes32" }
        ]
      }, {
        type: "tuple", components: [
          { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "bytes" },
          { name: "origin", type: "bytes" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }
        ]
      }],
      [{
        x: input.account.publicKey.x,
        y: input.account.publicKey.y,
        rpIdHash: sha256(stringToHex(input.account.rpId)),
        originHash: keccak256(stringToHex(input.account.origin))
      }, {
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
        origin: stringToHex(input.account.origin),
        r,
        s
      }]
    );
  }
  throw new Error("Only direct P-256 Loom guardians can sign with this passkey flow.");
}

export const signFreezeDigestWithPasskey = signGuardianDigestWithPasskey;
