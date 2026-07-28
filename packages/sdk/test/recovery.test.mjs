import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  parseAbiParameters,
  stringToHex
} from "viem";
import { ECDSAGuardianVerifierAbi, LoomAccountAbi, RecoveryManagerAbi } from "@loom/core";
import {
  GuardianRecoveryError,
  assembleGuardianApprovals,
  createFreezeDigest,
  createGuardianInvite,
  createGuardianLeaf,
  createGuardianProof,
  createGuardianSet,
  createGuardianRecoveryClient,
  createRecoveryCancellationDigest,
  createRecoveryId,
  createRecoveryProposalDigest,
  createScheduledOperationId,
  parseGuardianInvite,
  verifyGuardianProof
} from "../dist/recovery.js";

const account = "0x1111111111111111111111111111111111111111";
const recoveryManager = "0x2222222222222222222222222222222222222222";
const verifierA = "0x3333333333333333333333333333333333333333";
const verifierB = "0x4444444444444444444444444444444444444444";
const verifierC = "0x5555555555555555555555555555555555555555";
const codeHashA = `0x${"a1".repeat(32)}`;
const codeHashB = `0x${"a2".repeat(32)}`;
const codeHashC = `0x${"a3".repeat(32)}`;
const salt = `0x${"b1".repeat(32)}`;
const salt2 = `0x${"b2".repeat(32)}`;
const salt3 = `0x${"b3".repeat(32)}`;

const guardians = [
  { kind: "ecdsa", address: "0x6666666666666666666666666666666666666666", verifier: verifierA, verifierCodeHash: codeHashA, salt },
  {
    kind: "p256",
    publicKey: { x: `0x${"01".repeat(32)}`, y: `0x${"02".repeat(32)}` },
    verifier: verifierB,
    verifierCodeHash: codeHashB,
    salt: salt2
  },
  { kind: "erc1271", account: "0x7777777777777777777777777777777777777777", verifier: verifierC, verifierCodeHash: codeHashC, salt: salt3 }
];

const abiLeaf = guardian => {
  const keyCommitment = guardian.kind === "p256"
    ? keccak256(encodeAbiParameters(parseAbiParameters("bytes32 x, bytes32 y"), [guardian.publicKey.x, guardian.publicKey.y]))
    : keccak256(encodeAbiParameters(parseAbiParameters("address signer"), [guardian.address ?? guardian.account]));
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address verifier, bytes32 verifierCodeHash, bytes32 keyCommitment, bytes32 salt"),
    [guardian.verifier, guardian.verifierCodeHash, keyCommitment, guardian.salt]
  ));
};

test("guardian leaves and mixed-set proofs match Solidity ABI encoding byte-for-byte", () => {
  for (const guardian of guardians) assert.equal(createGuardianLeaf(guardian), abiLeaf(guardian));

  const set = createGuardianSet({ guardians: [...guardians].reverse(), threshold: 2 });
  assert.equal(set.threshold, 2);
  assert.deepEqual([...set.guardians].map(item => item.leaf), [...set.guardians].map(item => item.leaf).sort());
  for (const item of set.guardians) {
    const proof = createGuardianProof(set, item.leaf);
    assert.equal(verifyGuardianProof({ root: set.root, leaf: item.leaf, proof }), true);
  }
  const oddProof = createGuardianProof(set, set.guardians[2].leaf);
  assert.equal(verifyGuardianProof({ root: set.root, leaf: set.guardians[2].leaf, proof: oddProof }), true);
});

test("guardian sets generate an independent salt per omitted guardian and reject duplicate authority and invalid thresholds", () => {
  let randomCalls = 0;
  const generated = createGuardianSet({
    guardians: guardians.map(({ salt: _salt, ...guardian }) => guardian),
    threshold: 2,
    randomBytes(length) {
      assert.equal(length, 32);
      randomCalls += 1;
      return Uint8Array.from({ length }, () => randomCalls);
    }
  });
  assert.equal(randomCalls, guardians.length);
  assert.equal(new Set(generated.guardians.map(item => item.salt)).size, guardians.length);

  assert.throws(
    () => createGuardianSet({ guardians: [guardians[0], { ...guardians[1], salt }], threshold: 1 }),
    error => error instanceof GuardianRecoveryError && error.code === "DUPLICATE_GUARDIAN"
  );

  assert.throws(
    () => createGuardianSet({ guardians: [guardians[0], { ...guardians[0], salt: salt2 }], threshold: 1 }),
    error => error instanceof GuardianRecoveryError && error.code === "DUPLICATE_GUARDIAN"
  );
  assert.throws(
    () => createGuardianSet({ guardians, threshold: 4 }),
    error => error instanceof GuardianRecoveryError && error.code === "INVALID_THRESHOLD"
  );
});

test("individual invites contain one capability, round-trip, and fail closed on stale or unknown data", () => {
  const set = createGuardianSet({ guardians, threshold: 2 });
  const item = set.guardians.find(guardian => guardian.kind === "p256");
  const invite = createGuardianInvite({
    set,
    guardianLeaf: item.leaf,
    chainId: 11155111,
    account,
    accountAlias: "Savings",
    issuerLabel: "Alice",
    guardianSetVersion: 7,
    configVersion: 9n,
    capabilityId: `0x${"ca".repeat(32)}`,
    expiresAt: 2_000_000_000
  });
  const text = JSON.stringify(invite);
  assert.equal(text.includes("guardians"), false, "the full guardian set is not disclosed");
  assert.equal(parseGuardianInvite(text, {
    chainId: 11155111,
    account,
    guardianRoot: set.root,
    configVersion: 9n,
    now: 1_900_000_000
  }).capabilityId, invite.capabilityId);

  assert.throws(
    () => parseGuardianInvite(text, { chainId: 1, guardianRoot: set.root, now: 1_900_000_000 }),
    error => error instanceof GuardianRecoveryError && error.code === "DEPLOYMENT_CHAIN_MISMATCH"
  );
  assert.throws(
    () => parseGuardianInvite(JSON.stringify({ ...invite, unexpected: true }), { chainId: 11155111, guardianRoot: set.root, now: 1_900_000_000 }),
    error => error instanceof GuardianRecoveryError && error.code === "INVALID_GUARDIAN_INVITE"
  );
  assert.throws(
    () => parseGuardianInvite(text, { chainId: 11155111, guardianRoot: `0x${"ff".repeat(32)}`, now: 1_900_000_000 }),
    error => error instanceof GuardianRecoveryError && error.code === "STALE_GUARDIAN_INVITE"
  );
});

test("approval aggregation verifies and orders leaves without exposing Solidity ordering", async () => {
  const set = createGuardianSet({ guardians, threshold: 2 });
  const byLeaf = [...set.guardians].reverse().map((guardian, index) => ({
    leaf: guardian.leaf,
    signature: `0x${String(index + 1).padStart(2, "0")}`
  }));
  const result = await assembleGuardianApprovals({
    set,
    approvals: byLeaf,
    async verify({ signature }) { return signature !== "0x03"; }
  });
  assert.equal(result.have, 2);
  assert.equal(result.need, 2);
  assert.deepEqual(result.approvals.map(item => item.leaf), result.approvals.map(item => item.leaf).sort());
  assert.ok(result.approvals.every(item => !Object.hasOwn(item, "leaf") || typeof item.leaf === "string"));
});

test("freeze, recovery, cancellation, recovery id, and scheduled id match Solidity", () => {
  const leaf = abiLeaf(guardians[0]);
  const freezeTypehash = keccak256(stringToHex("Freeze(bytes32 guardianLeaf,uint256 nonce,uint64 configVersion)"));
  const domainTypehash = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const loomDomain = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, bytes32 nameHash, bytes32 versionHash, uint256 chainId, address verifyingContract"),
    [domainTypehash, keccak256(stringToHex("LoomAccount")), keccak256(stringToHex("1")), 11155111n, account]
  ));
  const freezeStruct = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, bytes32 leaf, uint256 nonce, uint64 configVersion"),
    [freezeTypehash, leaf, 4n, 9n]
  ));
  assert.equal(createFreezeDigest({ chainId: 11155111, account, guardianLeaf: leaf, nonce: 4n, configVersion: 9n }), keccak256(`0x1901${loomDomain.slice(2)}${freezeStruct.slice(2)}`));

  const proposal = {
    chainId: 11155111,
    recoveryManager,
    account,
    oldValidatorsHash: `0x${"11".repeat(32)}`,
    newValidator: "0x8888888888888888888888888888888888888888",
    initDataHash: `0x${"22".repeat(32)}`,
    newGuardianRoot: `0x${"33".repeat(32)}`,
    newGuardianThreshold: 2,
    configVersion: 9n,
    nonce: 4n
  };
  const proposalTypehash = keccak256(stringToHex("ProposeRecovery(address account,bytes32 oldValidatorsHash,address newValidator,bytes32 initDataHash,bytes32 newGuardianRoot,uint8 newGuardianThreshold,uint64 configVersion,uint64 nonce)"));
  const proposalStruct = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, address account, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 threshold, uint64 configVersion, uint64 nonce"),
    [proposalTypehash, proposal.account, proposal.oldValidatorsHash, proposal.newValidator, proposal.initDataHash, proposal.newGuardianRoot, 2, 9n, 4n]
  ));
  const recoveryDomain = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32 typehash, bytes32 nameHash, bytes32 versionHash, uint256 chainId, address verifyingContract"),
    [domainTypehash, keccak256(stringToHex("LoomRecoveryManager")), keccak256(stringToHex("1")), 11155111n, recoveryManager]
  ));
  assert.equal(createRecoveryProposalDigest(proposal), keccak256(`0x1901${recoveryDomain.slice(2)}${proposalStruct.slice(2)}`));

  const recoveryId = createRecoveryId(proposal);
  assert.equal(recoveryId, keccak256(encodeAbiParameters(
    parseAbiParameters("address account, bytes32 oldValidatorsHash, address newValidator, bytes32 initDataHash, bytes32 newGuardianRoot, uint8 threshold, uint64 configVersion, uint64 nonce"),
    [proposal.account, proposal.oldValidatorsHash, proposal.newValidator, proposal.initDataHash, proposal.newGuardianRoot, 2, 9n, 4n]
  )));
  const cancel = createRecoveryCancellationDigest({ chainId: 11155111, recoveryManager, account, recoveryId, configVersion: 9n, nonce: 4n });
  assert.match(cancel, /^0x[0-9a-f]{64}$/);

  const callData = "0x123456";
  assert.equal(createScheduledOperationId({ target: account, value: 0n, data: callData, configVersion: 9n }), keccak256(encodeAbiParameters(
    parseAbiParameters("address target, uint256 value, bytes data, uint64 configVersion"),
    [account, 0n, callData, 9n]
  )));
});

test("the recovery client owns account inspection, freeze verification, and proposal calldata", async () => {
  const verifierCode = "0x6001";
  const descriptor = {
    kind: "ecdsa",
    address: guardians[0].address,
    verifier: verifierA,
    verifierCodeHash: keccak256(verifierCode),
    salt
  };
  const currentSet = createGuardianSet({ guardians: [descriptor], threshold: 1 });
  const freshSet = createGuardianSet({ guardians: [{ ...descriptor, salt: salt2 }], threshold: 1 });
  const invite = createGuardianInvite({
    set: currentSet,
    guardianLeaf: currentSet.guardians[0].leaf,
    chainId: 11155111,
    account,
    accountAlias: "Savings",
    issuerLabel: "Alice",
    guardianSetVersion: 1,
    configVersion: 9n,
    capabilityId: `0x${"ab".repeat(32)}`,
    expiresAt: 2_000_000_000
  });
  const oldValidator = "0x8888888888888888888888888888888888888888";
  const newValidator = "0x9999999999999999999999999999999999999999";
  const policyHook = "0x7777777777777777777777777777777777777777";
  const validatorInitData = encodeAbiParameters(
    parseAbiParameters("bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash, address policyHook"),
    [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`, `0x${"04".repeat(32)}`, policyHook]
  );
  const submitted = [];
  const stateTransport = {
    async getCode() { return verifierCode; },
    async getBlockTimestamp() { return 1_900_000_000n; },
    async ethCall({ to, data }) {
      const abi = to.toLowerCase() === recoveryManager.toLowerCase()
        ? RecoveryManagerAbi
        : to.toLowerCase() === verifierA.toLowerCase()
          ? ECDSAGuardianVerifierAbi
          : LoomAccountAbi;
      const decoded = decodeFunctionData({ abi, data });
      const values = {
        guardianRoot: currentSet.root,
        guardianThreshold: 1,
        configVersion: 9n,
        frozenUntil: 0n,
        validatorCount: 1n,
        validatorAt: oldValidator,
        isModuleInstalled: true,
        freezeNonces: 4n,
        lastFreezeConfigVersion: 0n,
        scheduledOperations: 0n,
        recoveryNonces: 4n,
        pendingRecoveries: [`0x${"00".repeat(32)}`, "0x0000000000000000000000000000000000000000", `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, 0, 0n, 0n, 0n, 0n],
        verify: true
      };
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result: values[decoded.functionName] });
    }
  };
  const client = createGuardianRecoveryClient({
    chainId: 11155111,
    account,
    recoveryManager,
    stateTransport,
    trustedRecoveryValidators: [{
      kind: "p256",
      address: newValidator,
      runtimeCodeHash: keccak256(verifierCode),
      allowedPolicyHooks: [policyHook]
    }],
    submitTransport: { async submit(request) { submitted.push(request); return { hash: `0x${"12".repeat(32)}` }; } }
  });

  const inspected = await client.inspectAccount();
  assert.equal(inspected.recoveryConfigured, true);
  assert.deepEqual(inspected.validators, [oldValidator]);

  const freeze = await client.prepareFreeze(invite);
  assert.match(freeze.review.summary, /Freeze ordinary/);
  assert.equal(await client.verifyFreezeApproval(freeze, "0x01"), true);
  await client.submitFreeze(freeze, "0x01");
  assert.equal(submitted.at(-1).permissionless, true);
  assert.equal(decodeFunctionData({ abi: LoomAccountAbi, data: submitted.at(-1).data }).functionName, "freeze");

  const recovery = await client.prepareRecovery({ newValidator, initData: validatorInitData, newGuardianSet: freshSet });
  const collected = await client.collectRecoveryApproval(recovery, currentSet, [{ leaf: currentSet.guardians[0].leaf, signature: "0x01" }]);
  assert.equal(collected.ready, true);
  await client.proposeRecovery(recovery, collected.approvals);
  assert.equal(decodeFunctionData({ abi: RecoveryManagerAbi, data: submitted.at(-1).data }).functionName, "proposeRecovery");
  assert.match(recovery.review.summary, /Replace all 1 validator/);

  const untrustedClient = createGuardianRecoveryClient({ chainId: 11155111, account, recoveryManager, stateTransport });
  await assert.rejects(
    untrustedClient.prepareRecovery({ newValidator, initData: validatorInitData, newGuardianSet: freshSet }),
    error => error instanceof GuardianRecoveryError && error.code === "UNSUPPORTED_RECOVERED_VALIDATOR_PATH"
  );
  await assert.rejects(
    client.prepareRecovery({ newValidator, initData: "0x1234", newGuardianSet: freshSet }),
    error => error instanceof GuardianRecoveryError && error.code === "UNSUPPORTED_RECOVERED_VALIDATOR_PATH"
  );
});
