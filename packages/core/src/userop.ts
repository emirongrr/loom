import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { concatHex, fromHex, packUint128Pair, sizeOfHex, sliceHex, unpackUint128Pair } from "./bytes.js";
import { assertAddress } from "./hex.js";
import type { Address, Hex } from "./hex.js";

/**
 * Ergonomic ERC-4337 v0.9 user operation. Gas and fee fields are kept as
 * separate integers; factory and paymaster fields are present only when used.
 */
export interface UnpackedUserOperation {
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;
}

/**
 * The on-wire ERC-4337 v0.9 operation, matching the EntryPoint's
 * `PackedUserOperation` struct field-for-field:
 * - `accountGasLimits = uint128(verificationGasLimit) || uint128(callGasLimit)`
 * - `gasFees = uint128(maxPriorityFeePerGas) || uint128(maxFeePerGas)`
 * - `initCode = factory(20) || factoryData`
 * - `paymasterAndData = paymaster(20) || verificationGasLimit(16) || postOpGasLimit(16) || paymasterData`
 */
export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

/** Pack an ergonomic operation into the EntryPoint's on-wire representation. */
export function packUserOperation(op: UnpackedUserOperation): PackedUserOperation {
  const initCode: Hex =
    op.factory !== undefined ? concatHex(assertAddress(op.factory), op.factoryData ?? "0x") : "0x";

  const paymasterAndData: Hex =
    op.paymaster !== undefined
      ? concatHex(
          assertAddress(op.paymaster),
          packUint128Pair(op.paymasterVerificationGasLimit ?? 0n, op.paymasterPostOpGasLimit ?? 0n),
          op.paymasterData ?? "0x"
        )
      : "0x";

  return {
    sender: assertAddress(op.sender),
    nonce: op.nonce,
    initCode,
    callData: op.callData,
    accountGasLimits: packUint128Pair(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: op.preVerificationGas,
    gasFees: packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData,
    signature: op.signature
  };
}

/** Reverse {@link packUserOperation}: decode an on-wire operation back to the ergonomic form. */
export function unpackUserOperation(op: PackedUserOperation): UnpackedUserOperation {
  const [verificationGasLimit, callGasLimit] = unpackUint128Pair(op.accountGasLimits);
  const [maxPriorityFeePerGas, maxFeePerGas] = unpackUint128Pair(op.gasFees);

  const unpacked: UnpackedUserOperation = {
    sender: op.sender,
    nonce: op.nonce,
    callData: op.callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas: op.preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature: op.signature
  };

  if (sizeOfHex(op.initCode) >= 20) {
    unpacked.factory = sliceHex(op.initCode, 0, 20);
    const factoryData = sliceHex(op.initCode, 20);
    if (sizeOfHex(factoryData) > 0) unpacked.factoryData = factoryData;
  }

  if (sizeOfHex(op.paymasterAndData) >= 52) {
    unpacked.paymaster = sliceHex(op.paymasterAndData, 0, 20);
    unpacked.paymasterVerificationGasLimit = fromHex(sliceHex(op.paymasterAndData, 20, 36));
    unpacked.paymasterPostOpGasLimit = fromHex(sliceHex(op.paymasterAndData, 36, 52));
    const paymasterData = sliceHex(op.paymasterAndData, 52);
    if (sizeOfHex(paymasterData) > 0) unpacked.paymasterData = paymasterData;
  }

  return unpacked;
}

// EIP-712 constants, matching the on-chain EntryPoint v0.9
// (account-abstraction UserOperationLib and EntryPoint: DOMAIN_NAME "ERC4337",
// DOMAIN_VERSION "1"). The paymaster-signature suffix is not appended here, so
// keccak256(paymasterAndData) equals the EntryPoint's paymasterDataKeccak.
const PACKED_USEROP_TYPEHASH = keccak256(
  toBytes(
    "PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)"
  )
);
const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
);
const DOMAIN_NAME_HASH = keccak256(toBytes("ERC4337"));
const DOMAIN_VERSION_HASH = keccak256(toBytes("1"));

/**
 * EIP-712 `hashStruct` of a packed operation, equal to the EntryPoint's
 * `UserOperationLib.hash(userOp, 0)`. Dynamic fields are pre-hashed; the result
 * is independent of the EntryPoint address and chain.
 */
export function hashPackedUserOperation(op: PackedUserOperation): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" }
      ],
      [
        PACKED_USEROP_TYPEHASH,
        op.sender,
        op.nonce,
        keccak256(op.initCode),
        keccak256(op.callData),
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        keccak256(op.paymasterAndData)
      ]
    )
  );
}

/** EIP-712 domain separator the EntryPoint binds its user-operation hashes to. */
export function entryPointDomainSeparator(entryPoint: Address, chainId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, chainId, assertAddress(entryPoint)]
    )
  );
}

/**
 * The canonical ERC-4337 v0.9 user-operation hash a Loom account validates
 * against: `keccak256(0x1901 || domainSeparator || hashStruct)`, bound to the
 * given EntryPoint and chain.
 */
export function getUserOpHash(op: PackedUserOperation, entryPoint: Address, chainId: bigint): Hex {
  return keccak256(
    concatHex("0x1901", entryPointDomainSeparator(entryPoint, chainId), hashPackedUserOperation(op))
  );
}
