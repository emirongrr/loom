import type { Address, Hex } from "@loom/core";
import {
  createGuardianLeaf, createRecoveryId, createRecoveryProposalDigest, verifyGuardianProof,
  type GuardianApprovalTuple, type GuardianSetMember, type PreparedRecovery, type RecoveryRequestV1, type RecoveryResponseV1
} from "@loom/sdk/recovery";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

export function assertPreparedRecoveryMatchesRequest(prepared: PreparedRecovery, request: RecoveryRequestV1): void {
  if (
    prepared.recoveryId !== request.requestId
    || prepared.account !== request.account
    || prepared.newValidator !== request.newValidator
    || prepared.initDataHash !== request.initDataHash
    || prepared.newGuardianSet.root !== request.newGuardianRoot
    || prepared.newGuardianSet.threshold !== request.newGuardianThreshold
    || prepared.configVersion.toString() !== request.configVersion
    || prepared.nonce.toString() !== request.nonce
  ) throw new Error("Live recovery preparation no longer matches the reviewed request.");
}

export function restorePreparedRecovery(input: {
  readonly request: RecoveryRequestV1;
  readonly initData: Hex;
  readonly oldValidators: readonly Address[];
  readonly newGuardianSet: PreparedRecovery["newGuardianSet"];
}): PreparedRecovery {
  if (input.oldValidators.length < 1 || input.oldValidators.length > 16) throw new Error("Encrypted recovery session has no valid previous validator set.");
  if (keccak256(input.initData) !== input.request.initDataHash) throw new Error("Encrypted validator initialization data no longer matches the recovery request.");
  const oldValidators = Object.freeze([...input.oldValidators]);
  const oldValidatorsHash = keccak256(encodeAbiParameters(parseAbiParameters("address[] oldValidators"), [oldValidators]));
  const identity = {
    account: input.request.account,
    oldValidatorsHash,
    newValidator: input.request.newValidator,
    initDataHash: input.request.initDataHash,
    newGuardianRoot: input.newGuardianSet.root,
    newGuardianThreshold: input.newGuardianSet.threshold,
    configVersion: BigInt(input.request.configVersion),
    nonce: BigInt(input.request.nonce)
  };
  const prepared: PreparedRecovery = Object.freeze({
    kind: "guardian.recovery.prepared",
    account: input.request.account,
    oldValidators,
    oldValidatorsHash,
    newValidator: input.request.newValidator,
    initData: input.initData,
    initDataHash: input.request.initDataHash,
    newGuardianSet: input.newGuardianSet,
    configVersion: identity.configVersion,
    nonce: identity.nonce,
    digest: createRecoveryProposalDigest({ ...identity, chainId: input.request.chainId, recoveryManager: input.request.recoveryManager }),
    recoveryId: createRecoveryId(identity),
    review: Object.freeze({
      title: "Execute account recovery",
      action: "recovery",
      account: input.request.account,
      chainId: input.request.chainId,
      summary: `Replace all ${oldValidators.length} validator(s) with the reviewed recovery passkey.`,
      threshold: input.request.guardianThreshold,
      guardianCount: input.newGuardianSet.guardians.length,
      validatorChange: { from: oldValidators, to: input.request.newValidator },
      delaySeconds: 259_200,
      cancellation: "The pending recovery can no longer be changed by this execution call.",
      warnings: ["Execution transfers complete account control to the reviewed passkey."]
    })
  });
  assertPreparedRecoveryMatchesRequest(prepared, input.request);
  return prepared;
}

export async function verifyRecoveryResponseForProposal(input: {
  readonly response: RecoveryResponseV1;
  readonly request: RecoveryRequestV1;
  readonly prepared: PreparedRecovery;
  readonly readCode: (address: Address) => Promise<Hex | undefined>;
  readonly verifySignature: (input: { guardian: GuardianSetMember; signature: Hex }) => Promise<boolean>;
}): Promise<GuardianApprovalTuple> {
  const { response, request, prepared } = input;
  assertPreparedRecoveryMatchesRequest(prepared, request);
  if (response.recoveryDigest !== prepared.digest) throw new Error("Guardian response signed a different recovery digest.");
  const code = await input.readCode(response.verifier);
  if (!code || code === "0x") throw new Error("Guardian verifier has no live bytecode.");
  const guardian: GuardianSetMember = Object.freeze({
    kind: "ecdsa",
    verifier: response.verifier,
    verifierCodeHash: keccak256(code),
    keyCommitment: response.keyCommitment,
    salt: response.salt,
    leaf: response.guardianLeaf
  });
  if (createGuardianLeaf(guardian) !== response.guardianLeaf) throw new Error("Guardian response leaf does not match its live verifier.");
  if (!verifyGuardianProof({ root: request.guardianRoot, leaf: response.guardianLeaf, proof: response.proof })) {
    throw new Error("Guardian response does not belong to the active guardian root.");
  }
  if (!(await input.verifySignature({ guardian, signature: response.signature }))) {
    throw new Error("Guardian recovery signature is invalid.");
  }
  return Object.freeze({
    verifier: response.verifier,
    keyCommitment: response.keyCommitment,
    salt: response.salt,
    signature: response.signature,
    proof: response.proof,
    leaf: response.guardianLeaf
  });
}
