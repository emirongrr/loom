import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbiParameters,
  stringToHex
} from "viem";
import { ECDSAGuardianVerifierAbi, LoomAccountAbi, P256RecoveryValidatorFactoryAbi, P256ValidatorAbi, RecoveryManagerAbi } from "@loom/core/abi";
import {
  GuardianRecoveryError,
  assembleGuardianApprovals,
  createFreezeDigest,
  createGuardianInvite,
  createGuardianCapabilityV2,
  createGuardianLeaf,
  createGuardianProof,
  createGuardianSet,
  createGuardianRecoveryClient,
  createRecoveryCancellationDigest,
  createRecoveryId,
  createRecoveryRequest,
  createRecoveryResponse,
  createRecoveryProposalDigest,
  createScheduledOperationId,
  parseGuardianInvite,
  parseGuardianCapability,
  parseRecoveryRequest,
  parseRecoveryResponse,
  prepareP256RecoveryValidator,
  serializeRecoveryProtocol,
  serializeGuardianCapability,
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

test("recovery validator provisioning verifies the factory and prepares one deterministic deployment", async () => {
  const factory = "0x8888888888888888888888888888888888888888";
  const validator = "0x9999999999999999999999999999999999999999";
  const policyHook = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const factoryCode = "0x6001600055";
  const validatorCode = "0x6002600055";
  let validatorDeployed = false;
  const transport = {
    async getCode({ address }) {
      if (address.toLowerCase() === factory.toLowerCase()) return factoryCode;
      if (address.toLowerCase() === validator.toLowerCase()) return validatorDeployed ? validatorCode : "0x";
      return "0x";
    },
    async ethCall({ to, data }) {
      assert.equal(to, factory);
      const call = decodeFunctionData({ abi: P256RecoveryValidatorFactoryAbi, data });
      if (call.functionName === "fallbackVerifier") {
        return encodeFunctionResult({ abi: P256RecoveryValidatorFactoryAbi, functionName: "fallbackVerifier", result: "0x0000000000000000000000000000000000000000" });
      }
      if (call.functionName === "getAddress") {
        return encodeFunctionResult({ abi: P256RecoveryValidatorFactoryAbi, functionName: "getAddress", result: validator });
      }
      throw new Error(`unexpected factory read ${call.functionName}`);
    }
  };
  const initData = encodeFunctionData({
    abi: P256ValidatorAbi,
    functionName: "initialize",
    args: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, `0x${"33".repeat(32)}`, `0x${"44".repeat(32)}`, policyHook]
  });
  const profile = {
    address: factory,
    runtimeCodeHash: keccak256(factoryCode),
    validatorRuntimeCodeHash: keccak256(validatorCode),
    fallbackVerifier: "0x0000000000000000000000000000000000000000",
    allowedPolicyHooks: [policyHook]
  };

  const pending = await prepareP256RecoveryValidator({ account, recoveryNonce: 3n, initData, profile, stateTransport: transport });
  assert.equal(pending.validator, validator);
  assert.equal(pending.alreadyDeployed, false);
  assert.deepEqual(decodeFunctionData({ abi: P256RecoveryValidatorFactoryAbi, data: pending.deploy.data }).args, [account, 3n, keccak256(initData)]);

  validatorDeployed = true;
  const existing = await prepareP256RecoveryValidator({ account, recoveryNonce: 3n, initData, profile, stateTransport: transport });
  assert.equal(existing.alreadyDeployed, true);
  assert.equal(existing.deploy, undefined);

  await assert.rejects(
    prepareP256RecoveryValidator({ account, recoveryNonce: 3n, initData, profile: { ...profile, runtimeCodeHash: `0x${"ff".repeat(32)}` }, stateTransport: transport }),
    error => error instanceof GuardianRecoveryError && error.code === "UNSUPPORTED_RECOVERED_VALIDATOR_PATH"
  );
});

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

test("guardian capability v2 carries individualized current and standby epochs while v1 stays current-only", () => {
  const current = createGuardianSet({ guardians: [guardians[0]], threshold: 1 });
  const standby = createGuardianSet({ guardians: [{ ...guardians[0], salt: salt2 }], threshold: 1 });
  const v2 = createGuardianCapabilityV2({
    chainId: 11155111,
    account,
    accountAlias: "Savings",
    issuerLabel: "Alice",
    recoveryManager,
    capabilityId: `0x${"cd".repeat(32)}`,
    expiresAt: 2_000_000_000,
    current: { set: current, guardianLeaf: current.guardians[0].leaf, guardianSetVersion: 7, configVersion: 9n },
    standby: { set: standby, guardianLeaf: standby.guardians[0].leaf, guardianSetVersion: 8, configVersion: 10n, operationId: `0x${"de".repeat(32)}`, readyAt: 1_950_000_000n }
  });
  const parsed = parseGuardianCapability(serializeGuardianCapability(v2), { now: 1_900_000_000, chainId: 11155111, account, currentRoot: current.root, configVersion: 9n });
  assert.equal(parsed.recoveryCompleteness, "complete");
  assert.equal(parsed.standby.root, standby.root);
  assert.notEqual(parsed.current.guardian.salt, parsed.standby.guardian.salt);
  assert.equal(JSON.stringify(v2).includes(guardians[1].address ?? "never"), false, "unrelated guardian identities are not disclosed");

  const legacy = createGuardianInvite({
    set: current,
    guardianLeaf: current.guardians[0].leaf,
    chainId: 11155111,
    account,
    accountAlias: "Savings",
    issuerLabel: "Alice",
    guardianSetVersion: 7,
    configVersion: 9n,
    capabilityId: `0x${"ce".repeat(32)}`,
    expiresAt: 2_000_000_000
  });
  const legacyView = parseGuardianCapability(JSON.stringify(legacy), { now: 1_900_000_000 });
  assert.equal(legacyView.recoveryCompleteness, "current-only");
  assert.equal(legacyView.standby, undefined);

  assert.throws(
    () => parseGuardianCapability(JSON.stringify({ ...v2, unexpected: true }), { now: 1_900_000_000 }),
    error => error instanceof GuardianRecoveryError && error.code === "INVALID_GUARDIAN_INVITE"
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

test("manual recovery request and response artifacts are strict, bounded, and mutually bound", () => {
  const request = createRecoveryRequest({
    requestId: `0x${"91".repeat(32)}`,
    chainId: 11155111,
    account,
    recoveryManager,
    guardianRoot: `0x${"31".repeat(32)}`,
    guardianThreshold: 2,
    configVersion: "9",
    nonce: "4",
    newValidator: "0x8888888888888888888888888888888888888888",
    initDataHash: `0x${"41".repeat(32)}`,
    newGuardianRoot: `0x${"51".repeat(32)}`,
    newGuardianThreshold: 2,
    createdAt: 1_900_000_000,
    expiresAt: 1_900_086_400
  });
  const decoded = parseRecoveryRequest(serializeRecoveryProtocol(request), { now: 1_900_000_001, chainId: 11155111, account });
  assert.match(decoded.humanCode, /^[0-9]{6}$/);

  const response = createRecoveryResponse({
    requestId: request.requestId,
    chainId: request.chainId,
    account: request.account,
    recoveryDigest: `0x${"61".repeat(32)}`,
    guardianLeaf: `0x${"71".repeat(32)}`,
    verifier: verifierA,
    keyCommitment: `0x${"81".repeat(32)}`,
    salt,
    proof: [`0x${"92".repeat(32)}`],
    signature: "0x1234",
    signedAt: 1_900_000_100,
    expiresAt: request.expiresAt
  });
  assert.equal(parseRecoveryResponse(serializeRecoveryProtocol(response), request, { now: 1_900_000_101 }).requestId, request.requestId);

  assert.throws(
    () => parseRecoveryRequest(JSON.stringify({ ...request, unexpected: true }), { now: 1_900_000_001 }),
    error => error instanceof GuardianRecoveryError && error.code === "INVALID_RECOVERY_REQUEST"
  );
  assert.throws(
    () => parseRecoveryRequest(serializeRecoveryProtocol(request), { now: request.expiresAt }),
    error => error instanceof GuardianRecoveryError && error.code === "INVALID_RECOVERY_REQUEST"
  );
  assert.throws(
    () => parseRecoveryResponse(serializeRecoveryProtocol({ ...response, requestId: `0x${"ff".repeat(32)}` }), request, { now: 1_900_000_101 }),
    error => error instanceof GuardianRecoveryError && error.code === "INVALID_RECOVERY_RESPONSE"
  );
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
  const validatorInitArgs = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`, `0x${"04".repeat(32)}`, policyHook];
  const validatorInitData = encodeFunctionData({
    abi: P256ValidatorAbi,
    functionName: "initialize",
    args: validatorInitArgs
  });
  const submitted = [];
  let liveConfigVersion = 9n;
  let liveRecoveryNonce = 4n;
  // (readyAt, expiresAt, nonce) — the shape `scheduledOperations` actually
  // returns. Encoding through the real ABI means a single value would not even
  // encode, which is how the drift surfaced.
  let liveScheduledOperation = [0, 0, 0];
  let livePendingRecovery = [`0x${"00".repeat(32)}`, "0x0000000000000000000000000000000000000000", `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, 0, 0n, 0n, 0n, 0n];
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
        configVersion: liveConfigVersion,
        frozenUntil: 0n,
        validatorCount: 1n,
        validatorAt: oldValidator,
        isModuleInstalled: true,
        freezeNonces: 4n,
        lastFreezeConfigVersion: 0n,
        scheduledOperations: liveScheduledOperation,
        recoveryNonces: liveRecoveryNonce,
        pendingRecoveries: livePendingRecovery,
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

  const guardianConfiguration = await client.prepareGuardianConfiguration({ set: currentSet });
  liveScheduledOperation = [1_900_000_100, 1_900_000_100 + 30 * 24 * 60 * 60, 0];
  const scheduled = await client.readPendingGuardianConfiguration(guardianConfiguration);
  assert.equal(scheduled.readyAt, 1_900_000_100n);
  assert.equal(scheduled.expiresAt, 1_900_000_100n + 2_592_000n);
  assert.equal(scheduled.expired, false);
  assert.equal(typeof scheduled.chainTimestamp, "bigint");
  liveScheduledOperation = [0, 0, 0];

  const freeze = await client.prepareFreeze(invite);
  assert.match(freeze.review.summary, /Freeze ordinary/);
  assert.equal(await client.verifyFreezeApproval(freeze, "0x01"), true);
  await client.submitFreeze(freeze, "0x01");
  assert.equal(submitted.at(-1).permissionless, true);
  assert.equal(decodeFunctionData({ abi: LoomAccountAbi, data: submitted.at(-1).data }).functionName, "freeze");

  const recovery = await client.prepareRecovery({ newValidator, initData: validatorInitData, newGuardianSet: freshSet });
  const collected = await client.collectRecoveryApproval(recovery, currentSet, [{ leaf: currentSet.guardians[0].leaf, signature: "0x01" }]);
  assert.equal(collected.ready, true);
  liveConfigVersion = 10n;
  await assert.rejects(
    client.proposeRecovery(recovery, collected.approvals),
    error => error instanceof GuardianRecoveryError && error.code === "RECOVERY_CONFIG_VERSION_MISMATCH"
  );
  liveConfigVersion = 9n;
  liveRecoveryNonce = 5n;
  await assert.rejects(
    client.proposeRecovery(recovery, collected.approvals),
    error => error instanceof GuardianRecoveryError && error.code === "RECOVERY_CONFIG_VERSION_MISMATCH"
  );
  liveRecoveryNonce = 4n;
  await client.proposeRecovery(recovery, collected.approvals);
  assert.equal(decodeFunctionData({ abi: RecoveryManagerAbi, data: submitted.at(-1).data }).functionName, "proposeRecovery");
  assert.match(recovery.review.summary, /Replace all 1 validator/);

  await client.cancelRecovery(recovery.review, collected.approvals);
  const ownerCancellation = decodeFunctionData({ abi: RecoveryManagerAbi, data: submitted.at(-1).data });
  assert.equal(ownerCancellation.functionName, "cancelRecoveryWithAccountAndGuardians");
  assert.equal(ownerCancellation.args[0], account);
  assert.equal(ownerCancellation.args[1].length, 1);
  assert.equal(submitted.at(-1).permissionless, false);

  const twoGuardianSet = createGuardianSet({ guardians, threshold: 2 });
  const twoGuardianApprovals = await assembleGuardianApprovals({
    set: twoGuardianSet,
    approvals: twoGuardianSet.guardians.map((guardian, index) => ({ leaf: guardian.leaf, signature: `0x0${index + 1}` }))
  });
  const reversedApprovals = [...twoGuardianApprovals.approvals].reverse();
  await client.cancelRecovery(recovery.review, reversedApprovals);
  const sortedOwnerCancellation = decodeFunctionData({ abi: RecoveryManagerAbi, data: submitted.at(-1).data });
  assert.deepEqual(
    sortedOwnerCancellation.args[1].map(approval => approval.keyCommitment),
    twoGuardianApprovals.approvals.map(approval => approval.keyCommitment)
  );

  await client.cancelRecoveryWithGuardians(recovery.review, reversedApprovals);
  const sortedGuardianCancellation = decodeFunctionData({ abi: RecoveryManagerAbi, data: submitted.at(-1).data });
  assert.deepEqual(
    sortedGuardianCancellation.args[1].map(approval => approval.keyCommitment),
    twoGuardianApprovals.approvals.map(approval => approval.keyCommitment)
  );

  livePendingRecovery = [
    recovery.oldValidatorsHash,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    recovery.initDataHash,
    recovery.newGuardianSet.root,
    recovery.newGuardianSet.threshold,
    1_800_000_000n,
    2_000_000_000n,
    recovery.configVersion,
    recovery.nonce
  ];
  await assert.rejects(
    client.executeRecovery(recovery),
    error => error instanceof GuardianRecoveryError && error.code === "RECOVERY_CONFIG_VERSION_MISMATCH"
  );
  livePendingRecovery = [
    recovery.oldValidatorsHash,
    recovery.newValidator,
    recovery.initDataHash,
    recovery.newGuardianSet.root,
    recovery.newGuardianSet.threshold,
    1_800_000_000n,
    2_000_000_000n,
    recovery.configVersion,
    recovery.nonce
  ];
  await client.executeRecovery(recovery);
  assert.equal(decodeFunctionData({ abi: RecoveryManagerAbi, data: submitted.at(-1).data }).functionName, "executeRecovery");
  livePendingRecovery = [`0x${"00".repeat(32)}`, "0x0000000000000000000000000000000000000000", `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, 0, 0n, 0n, 0n, 0n];

  const recoveryFactory = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const factoryStateTransport = {
    ...stateTransport,
    async ethCall(request) {
      if (request.to.toLowerCase() !== recoveryFactory.toLowerCase()) return stateTransport.ethCall(request);
      const call = decodeFunctionData({ abi: P256RecoveryValidatorFactoryAbi, data: request.data });
      if (call.functionName === "fallbackVerifier") {
        return encodeFunctionResult({ abi: P256RecoveryValidatorFactoryAbi, functionName: "fallbackVerifier", result: "0x0000000000000000000000000000000000000000" });
      }
      if (call.functionName === "getAddress") {
        return encodeFunctionResult({ abi: P256RecoveryValidatorFactoryAbi, functionName: "getAddress", result: newValidator });
      }
      throw new Error(`unexpected factory read ${call.functionName}`);
    }
  };
  const factoryClient = createGuardianRecoveryClient({
    chainId: 11155111,
    account,
    recoveryManager,
    stateTransport: factoryStateTransport,
    recoveryValidatorFactory: {
      address: recoveryFactory,
      runtimeCodeHash: keccak256(verifierCode),
      validatorRuntimeCodeHash: keccak256(verifierCode),
      fallbackVerifier: "0x0000000000000000000000000000000000000000",
      allowedPolicyHooks: [policyHook]
    }
  });
  const factoryValidator = await factoryClient.prepareRecoveryValidator({ initData: validatorInitData });
  assert.equal(factoryValidator.validator, newValidator);
  assert.equal(factoryValidator.alreadyDeployed, true);
  const factoryRecovery = await factoryClient.prepareRecovery({ newValidator, initData: validatorInitData, newGuardianSet: freshSet });
  assert.equal(factoryRecovery.newValidator, newValidator);

  const untrustedClient = createGuardianRecoveryClient({ chainId: 11155111, account, recoveryManager, stateTransport });
  await assert.rejects(
    untrustedClient.prepareRecovery({ newValidator, initData: validatorInitData, newGuardianSet: freshSet }),
    error => error instanceof GuardianRecoveryError && error.code === "UNSUPPORTED_RECOVERED_VALIDATOR_PATH"
  );
  await assert.rejects(
    client.prepareRecovery({ newValidator, initData: "0x1234", newGuardianSet: freshSet }),
    error => error instanceof GuardianRecoveryError && error.code === "UNSUPPORTED_RECOVERED_VALIDATOR_PATH"
  );
  const selectorlessInitData = encodeAbiParameters(
    parseAbiParameters("bytes32 x, bytes32 y, bytes32 rpIdHash, bytes32 originHash, address policyHook"),
    validatorInitArgs
  );
  await assert.rejects(
    client.prepareRecovery({ newValidator, initData: selectorlessInitData, newGuardianSet: freshSet }),
    error => error instanceof GuardianRecoveryError && error.code === "UNSUPPORTED_RECOVERED_VALIDATOR_PATH"
  );
});
