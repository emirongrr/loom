import { keccak_256 } from "js-sha3";

import type { Hex, ReleaseGate } from "../../types/wallet";
import type { LoomStateReadTransport } from "@loom/sdk";
import type { DeploymentManifest } from "./manifest";

// On-chain code hash confirmation (G-002).
//
// parseDeploymentManifest/verifyDeploymentAgainstManifest only check that the
// app's configured addresses match a committed manifest — they are pure
// functions with no network access. This module does the part that manifest
// verification explicitly defers: reading the deployed bytecode at each
// pinned address through the app's own state transport (Helios-verified when
// available) and confirming it hashes to the value the manifest committed to.
// A matching address with the wrong bytecode is exactly what a malicious or
// misconfigured RPC could try to present.

const ACCOUNT_IMPLEMENTATION_SELECTOR = ("0x" + keccak_256("accountImplementation()").slice(0, 8)) as Hex;

function codehash(bytecode: Hex): Hex {
  return ("0x" + keccak_256(hexToBytes(bytecode))) as Hex;
}

function hexToBytes(value: Hex): Uint8Array {
  const clean = value.slice(2);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function decodeAddress(word: Hex): Hex {
  return ("0x" + word.slice(-40)) as Hex;
}

async function verifyRoleCodehash(input: {
  role: string;
  address: Hex | undefined;
  manifest: DeploymentManifest;
  stateTransport: LoomStateReadTransport;
}): Promise<ReleaseGate | undefined> {
  const { role, address, manifest, stateTransport } = input;
  if (!address) {
    return undefined;
  }

  const expected = manifest.codehashes[role];
  if (!expected) {
    return {
      id: `deployment.onchain.${role}.no-manifest-hash`,
      title: "On-chain code hash not confirmed",
      status: "not-configured",
      summary: `Manifest has no committed code hash for ${role}; on-chain bytecode cannot be confirmed.`
    };
  }

  if (!stateTransport.getCode) {
    return {
      id: `deployment.onchain.${role}.no-getcode-support`,
      title: "On-chain code hash not confirmed",
      status: "blocked",
      summary: `The active state transport does not support getCode; ${role} bytecode cannot be confirmed.`
    };
  }

  const bytecode = await stateTransport.getCode({ address });
  if (!bytecode || bytecode === "0x") {
    return {
      id: `deployment.onchain.${role}.not-deployed`,
      title: "On-chain code hash not confirmed",
      status: "blocked",
      summary: `No bytecode found at the configured ${role} address on this chain.`
    };
  }

  const actual = codehash(bytecode);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return {
      id: `deployment.onchain.${role}.mismatch`,
      title: "On-chain code hash does not match manifest",
      status: "blocked",
      summary: `Deployed bytecode at the ${role} address does not hash to the manifest's committed code hash.`
    };
  }

  return undefined;
}

/**
 * Reads deployed bytecode for every manifest-pinned address through the
 * caller's state transport and confirms it hashes to the manifest's committed
 * code hash. Also resolves LoomAccountFactory.accountImplementation() and
 * confirms that address's code hash, since the implementation contract has no
 * top-level manifest field of its own. Returns a blocked/not-configured gate
 * per role that could not be confirmed; an empty array means every pinned
 * address that could be checked was confirmed on chain.
 */
export async function verifyManifestCodehashesOnChain(
  manifest: DeploymentManifest,
  stateTransport: LoomStateReadTransport
): Promise<readonly ReleaseGate[]> {
  const gates: ReleaseGate[] = [];

  const directRoles: readonly { role: string; address: Hex | undefined }[] = [
    { role: "entryPoint", address: manifest.entryPoint },
    { role: "accountFactory", address: manifest.accountFactory },
    { role: "passkeyValidator", address: manifest.passkeyValidator },
    ...(manifest.p256VerifierMode === "fallback-contract"
      ? [{ role: "p256Verifier", address: manifest.p256Verifier }]
      : [])
  ];

  for (const { role, address } of directRoles) {
    const gate = await verifyRoleCodehash({ role, address, manifest, stateTransport });
    if (gate) {
      gates.push(gate);
    }
  }

  if (manifest.codehashes.accountImplementation) {
    if (!stateTransport.ethCall) {
      gates.push({
        id: "deployment.onchain.accountImplementation.no-ethcall-support",
        title: "On-chain code hash not confirmed",
        status: "blocked",
        summary: "The active state transport does not support ethCall; accountImplementation cannot be resolved."
      });
    } else {
      try {
        const result = await stateTransport.ethCall({
          to: manifest.accountFactory,
          data: ACCOUNT_IMPLEMENTATION_SELECTOR
        });
        const implementation = decodeAddress(result);
        const gate = await verifyRoleCodehash({
          role: "accountImplementation",
          address: implementation,
          manifest,
          stateTransport
        });
        if (gate) {
          gates.push(gate);
        }
      } catch {
        gates.push({
          id: "deployment.onchain.accountImplementation.lookup-failed",
          title: "On-chain code hash not confirmed",
          status: "blocked",
          summary: "Calling accountFactory.accountImplementation() failed; the implementation address could not be resolved."
        });
      }
    }
  }

  return gates;
}
