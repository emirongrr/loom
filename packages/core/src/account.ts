import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256 } from "viem";
import { LoomAccountAbi } from "./abi/loom-account.js";
import { LoomAccountFactoryAbi } from "./abi/loom-account-factory.js";
import { concatHex } from "./bytes.js";
import { LoomError } from "./errors.js";
import { assertAddress, equalHex } from "./hex.js";
import type { Address, Hex } from "./hex.js";

/** Mirror of the on-chain `LoomAccount.ModuleInit` struct. */
export interface ModuleInit {
  moduleTypeId: bigint;
  module: Address;
  initData: Hex;
}

/** The account configuration a factory deployment commits to. */
export interface AccountInitConfig {
  entryPoint: Address;
  guardianRoot: Hex;
  guardianThreshold: number;
  configHash: Hex;
  modules: readonly ModuleInit[];
}

// The ABIs are generated from the reviewed Foundry artifacts (see src/abi/),
// so the encodings below can never drift from the contract signatures.

function moduleTuples(modules: readonly ModuleInit[]) {
  return modules.map(module => ({
    moduleTypeId: module.moduleTypeId,
    module: assertAddress(module.module),
    initData: module.initData
  }));
}

/** Calldata for `LoomAccount.initialize`, exactly as the factory encodes it. */
export function encodeInitializeCall(config: AccountInitConfig): Hex {
  return encodeFunctionData({
    abi: LoomAccountAbi,
    functionName: "initialize",
    args: [
      assertAddress(config.entryPoint),
      config.guardianRoot,
      config.guardianThreshold,
      config.configHash,
      moduleTuples(config.modules)
    ]
  });
}

/**
 * Calldata for `LoomAccountFactory.createAccount` — the `factoryData` an
 * ERC-4337 operation carries when the account is still counterfactual.
 */
export function encodeCreateAccountCall(salt: Hex, config: Omit<AccountInitConfig, "entryPoint">): Hex {
  return encodeFunctionData({
    abi: LoomAccountFactoryAbi,
    functionName: "createAccount",
    args: [salt, config.guardianRoot, config.guardianThreshold, config.configHash, moduleTuples(config.modules)]
  });
}

/** EIP-1014 `CREATE2` address: `keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:]`. */
export function computeCreate2Address(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  const digest = keccak256(concatHex("0xff", assertAddress(deployer), salt, initCodeHash));
  return getAddress(`0x${digest.slice(26)}`);
}

export interface AccountAddressInput {
  factory: Address;
  implementation: Address;
  /**
   * The full `LoomAccountProxy` creation code from reviewed build artifacts.
   * Constructor arguments are appended to it before hashing, so the code hash
   * alone is not sufficient for local derivation.
   */
  proxyCreationCode: Hex;
  /**
   * Optional fail-closed binding to the canonical deployment manifest: when
   * given, `keccak256(proxyCreationCode)` must equal this value (the manifest's
   * `account.proxy.creationCodeHash`) or derivation refuses to proceed.
   */
  expectedProxyCreationCodeHash?: Hex;
  salt: Hex;
  config: AccountInitConfig;
}

/**
 * Locally derive the counterfactual account address, mirroring
 * `LoomAccountFactory.getAddress`: the proxy is deployed with
 * `abi.encode(implementation, initializeCalldata)` constructor arguments under
 * CREATE2 from the factory.
 */
export function deriveAccountAddress(input: AccountAddressInput): Address {
  if (input.expectedProxyCreationCodeHash !== undefined) {
    const actual = keccak256(input.proxyCreationCode);
    if (!equalHex(actual, input.expectedProxyCreationCodeHash)) {
      throw new LoomError("MANIFEST_CODE_HASH_MISMATCH", `proxy creation code hash ${actual} does not match expected`, {
        safeMessage: "proxy creation code does not match the deployment manifest",
        details: { actual, expected: input.expectedProxyCreationCodeHash }
      });
    }
  }
  const constructorArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    [assertAddress(input.implementation), encodeInitializeCall(input.config)]
  );
  const initCodeHash = keccak256(concatHex(input.proxyCreationCode, constructorArgs));
  return computeCreate2Address(input.factory, input.salt, initCodeHash);
}
