import type { Address, Hex } from "@loom/core";
import { LoomAccountAbi, LoomAccountFactoryAbi, P256GuardianVerifierAbi, P256ValidatorAbi } from "@loom/core/abi";
import type { GuardianDescriptor } from "@loom/sdk/recovery";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, isAddress, keccak256, stringToHex } from "viem";
import type { NetworkConfig } from "../../config/network";
import type { WalletDeployment } from "../onboarding/accountLifecycle";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const MAX_VALIDATORS = 16n;
const RegistryAbi = [{
  type: "function", name: "isAccount", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }]
}] as const;
const ERC1271Abi = [{
  type: "function", name: "isValidSignature", stateMutability: "view",
  inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
  outputs: [{ name: "magicValue", type: "bytes4" }]
}] as const;
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC1271_PROBE_DIGEST = keccak256(stringToHex("loom.guardian.erc1271.interface-probe"));

export interface LoomGuardianChainReader {
  isRegisteredAccount(account: Address): Promise<boolean>;
  accountCode(account: Address): Promise<Hex | undefined>;
  supportsERC1271(account: Address): Promise<"supported" | "inconclusive" | "unsafe">;
  validatorCount(account: Address): Promise<bigint>;
  validatorAt(account: Address, index: bigint): Promise<Address>;
  validatorCodeHash(validator: Address): Promise<Hex>;
  validatorPublicKey(validator: Address, account: Address): Promise<readonly [Hex, Hex, Hex, Hex]>;
  validatorFallbackVerifier(validator: Address): Promise<Address>;
  guardianVerifierFallbackVerifier(verifier: Address): Promise<Address>;
}

export type DetectedGuardianAddress = Readonly<{
  kind: "loom" | "ecdsa" | "erc1271";
  address: Address;
  warning?: string;
}>;

/**
 * Compatibility discovery for deployments that still publish separate ECDSA
 * and ERC-1271 verifiers. Loom accounts are resolved first because their
 * pinned P-256 authority is safer than treating the mutable account as an
 * ERC-1271 guardian. Other deployed contracts use ERC-1271; an address with
 * no runtime code uses ECDSA.
 */
export async function detectGuardianAddress(
  value: string,
  reader: LoomGuardianChainReader
): Promise<DetectedGuardianAddress> {
  const candidate = value.trim();
  if (!isAddress(candidate)) throw new Error("Enter a valid guardian address.");
  const address = getAddress(candidate);
  if (await reader.isRegisteredAccount(address)) return Object.freeze({ kind: "loom", address });
  const code = await reader.accountCode(address);
  if (!code || code === "0x") return Object.freeze({ kind: "ecdsa", address });
  const support = await reader.supportsERC1271(address);
  if (support === "unsafe") {
    throw new Error("This contract accepted an invalid ERC-1271 probe signature, so it cannot be used safely as a guardian.");
  }
  return Object.freeze({
    kind: "erc1271",
    address,
    ...(support === "inconclusive" ? { warning: "Warning: this contract has code, but ERC-1271 support could not be verified from an invalid-signature probe. Confirm that the wallet documents ERC-1271 support before relying on it for recovery." } : {})
  });
}

/**
 * Resolve a factory-registered Loom address to the P-256 authority that will
 * become the guardian leaf. The Loom address is discovery input only: the
 * returned descriptor contains no account address and creates no public
 * owner-to-guardian linkage beyond a guardian's later voluntary proof use.
 */
export async function resolveLoomP256Guardian(input: {
  value: string;
  deployment: WalletDeployment;
  verifierCodeHash: Hex;
  reader: LoomGuardianChainReader;
}): Promise<GuardianDescriptor> {
  const value = input.value.trim();
  if (!isAddress(value)) throw new Error("Enter the Loom wallet address.");
  const account = getAddress(value);
  const verifier = input.deployment.guardianVerifiers?.p256;
  if (!verifier) throw new Error("This deployment has no P-256 guardian verifier.");
  if (!await input.reader.isRegisteredAccount(account)) {
    throw new Error("This address is not a Loom wallet created by this deployment.");
  }

  const count = await input.reader.validatorCount(account);
  if (count < 1n || count > MAX_VALIDATORS) throw new Error("The Loom wallet has no supported validator set.");
  const expectedFallback = await input.reader.guardianVerifierFallbackVerifier(verifier);
  const keys = new Map<string, { x: Hex; y: Hex }>();

  for (let index = 0n; index < count; index += 1n) {
    const validator = getAddress(await input.reader.validatorAt(account, index));
    const isPrimary = validator.toLowerCase() === input.deployment.validator.toLowerCase();
    const isTrustedRecovery = !isPrimary && input.deployment.recoveryValidatorProvisioner !== undefined
      && (await input.reader.validatorCodeHash(validator)).toLowerCase()
        === input.deployment.recoveryValidatorProvisioner.validatorRuntimeCodeHash.toLowerCase();
    if (!isPrimary && !isTrustedRecovery) continue;

    const fallback = await input.reader.validatorFallbackVerifier(validator);
    if (fallback.toLowerCase() !== expectedFallback.toLowerCase()) continue;
    const [x, y, rpIdHash, originHash] = await input.reader.validatorPublicKey(validator, account);
    if ([x, y, rpIdHash, originHash].some(word => word.toLowerCase() === ZERO_BYTES32)) continue;
    keys.set(`${x.toLowerCase()}:${y.toLowerCase()}`, { x, y });
  }

  if (keys.size === 0) throw new Error("This Loom wallet has no trusted active P-256 passkey.");
  if (keys.size > 1) throw new Error("This Loom wallet has more than one active P-256 key. Choose a dedicated passkey guardian instead.");
  const publicKey = [...keys.values()][0]!;
  return Object.freeze({ kind: "p256", publicKey, verifier, verifierCodeHash: input.verifierCodeHash });
}

export function createLoomGuardianChainReader(config: NetworkConfig, deployment: WalletDeployment): LoomGuardianChainReader {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  return Object.freeze({
    async isRegisteredAccount(account: Address) {
      const registry = await client.readContract({ address: deployment.factory, abi: LoomAccountFactoryAbi, functionName: "registry" });
      return client.readContract({ address: registry, abi: RegistryAbi, functionName: "isAccount", args: [account] });
    },
    accountCode: (account: Address) => client.getCode({ address: account }),
    async supportsERC1271(account: Address) {
      const data = encodeFunctionData({
        abi: ERC1271Abi,
        functionName: "isValidSignature",
        args: [ERC1271_PROBE_DIGEST, "0x"]
      });
      try {
        const result = await client.call({ to: account, data });
        if (!result.data) return "inconclusive";
        const value = decodeFunctionResult({ abi: ERC1271Abi, functionName: "isValidSignature", data: result.data });
        // The probe deliberately has no valid signature. Returning the magic
        // value would describe an unsafe accept-all verifier, not support.
        return value.toLowerCase() === ERC1271_MAGIC_VALUE ? "unsafe" : "supported";
      } catch {
        // ERC-1271 does not standardize interface discovery and some contracts
        // revert for invalid signatures. That is inconclusive, so fail closed.
        return "inconclusive";
      }
    },
    validatorCount: (account: Address) => client.readContract({ address: account, abi: LoomAccountAbi, functionName: "validatorCount" }),
    validatorAt: (account: Address, index: bigint) => client.readContract({ address: account, abi: LoomAccountAbi, functionName: "validatorAt", args: [index] }),
    async validatorCodeHash(validator: Address) {
      const code = await client.getCode({ address: validator });
      return !code || code === "0x" ? ZERO_BYTES32 : keccak256(code);
    },
    validatorPublicKey: (validator: Address, account: Address) => client.readContract({ address: validator, abi: P256ValidatorAbi, functionName: "publicKeys", args: [account] }),
    validatorFallbackVerifier: (validator: Address) => client.readContract({ address: validator, abi: P256ValidatorAbi, functionName: "fallbackVerifier" }),
    guardianVerifierFallbackVerifier: (verifier: Address) => client.readContract({ address: verifier, abi: P256GuardianVerifierAbi, functionName: "fallbackVerifier" })
  });
}
