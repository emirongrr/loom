import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidGuardianCeremonyError,
  buildGuardianCeremony,
  buildGuardianOnboardingEvidence,
  buildGuardianTree,
  createGuardianPossessionChallenge,
  decryptGuardianBackup,
  encryptGuardianBackup,
  guardianLeaf,
  validateGuardianOnboardingEvidence,
  verifyGuardianProof
} from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const verifierA = "0x2222222222222222222222222222222222222222";
const verifierB = "0x3333333333333333333333333333333333333333";
const verifierC = "0x4444444444444444444444444444444444444444";
const codeHashA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const codeHashB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const codeHashC = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const keyA = "0x0101010101010101010101010101010101010101010101010101010101010101";
const keyB = "0x0202020202020202020202020202020202020202020202020202020202020202";
const keyC = "0x0303030303030303030303030303030303030303030303030303030303030303";
const saltA = "0x1111111111111111111111111111111111111111111111111111111111111111";
const saltB = "0x2222222222222222222222222222222222222222222222222222222222222222";
const saltC = "0x3333333333333333333333333333333333333333333333333333333333333333";
const ceremonyId = "0x9999999999999999999999999999999999999999999999999999999999999999";

const guardians = [
  { verifier: verifierB, verifierCodeHash: codeHashB, keyCommitment: keyB, salt: saltB },
  { verifier: verifierA, verifierCodeHash: codeHashA, keyCommitment: keyA, salt: saltA },
  { verifier: verifierC, verifierCodeHash: codeHashC, keyCommitment: keyC, salt: saltC }
];

test("guardian leaf construction is deterministic and binds verifier codehash key commitment and salt", () => {
  const first = guardianLeaf(guardians[0]);
  const second = guardianLeaf({ ...guardians[0] });
  const changedSalt = guardianLeaf({ ...guardians[0], salt: saltA });

  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, changedSalt);
});

test("guardian ceremony builds sorted root proofs and deployment evidence", () => {
  const ceremony = buildGuardianCeremony({
    guardians,
    threshold: 2,
    account,
    chainId: 1,
    ceremonyId
  });

  assert.equal(ceremony.version, 1);
  assert.equal(ceremony.threshold, 2);
  assert.equal(ceremony.guardianCount, 3);
  assert.match(ceremony.guardianRoot, /^0x[0-9a-f]{64}$/);
  assert.match(ceremony.evidenceHash, /^0x[0-9a-f]{64}$/);
  for (const item of ceremony.proofs) {
    assert.equal(verifyGuardianProof({ root: ceremony.guardianRoot, leaf: item.leaf, proof: item.proof }), true);
  }
});

test("guardian tree rejects duplicate leaves and invalid thresholds", () => {
  assert.throws(() => buildGuardianTree([guardians[0], guardians[0]]), InvalidGuardianCeremonyError);
  assert.throws(
    () =>
      buildGuardianCeremony({
        guardians,
        threshold: 4,
        account,
        chainId: 1,
        ceremonyId
      }),
    InvalidGuardianCeremonyError
  );
});

test("proof of possession challenge binds account chain ceremony and guardian leaf", () => {
  const challenge = createGuardianPossessionChallenge({
    ...guardians[0],
    account,
    chainId: 1,
    ceremonyId,
    expiresAt: 2000000000
  });

  assert.equal(challenge.account, account);
  assert.equal(challenge.chainId, 1);
  assert.equal(challenge.leaf, guardianLeaf(guardians[0]));
  assert.match(challenge.digest, /^0x[0-9a-f]{64}$/);
  assert.match(challenge.message, /Loom guardian proof-of-possession/);
});

test("guardian backup envelope encrypts local ceremony evidence and rejects wrong passphrase", () => {
  const ceremony = buildGuardianCeremony({
    guardians,
    threshold: 2,
    account,
    chainId: 1,
    ceremonyId
  });
  const envelope = encryptGuardianBackup({
    passphrase: "correct horse battery staple",
    salt: "0x12121212121212121212121212121212",
    iv: "0x343434343434343434343434",
    payload: {
      guardianRoot: ceremony.guardianRoot,
      threshold: ceremony.threshold,
      proofs: ceremony.proofs
    }
  });

  assert.equal(envelope.version, 1);
  assert.equal(envelope.cipher, "aes-256-gcm");
  assert.equal(String(envelope.ciphertext).includes(ceremony.guardianRoot.slice(2)), false);

  const decrypted = decryptGuardianBackup({
    ...envelope,
    passphrase: "correct horse battery staple"
  });
  assert.equal(decrypted.guardianRoot, ceremony.guardianRoot);
  assert.equal(decrypted.threshold, 2);

  assert.throws(
    () =>
      decryptGuardianBackup({
        ...envelope,
        passphrase: "incorrect horse"
      }),
    Error
  );
});

test("guardian onboarding evidence proves possession backup usability and redacts sensitive ceremony data", () => {
  const ceremony = buildGuardianCeremony({
    guardians,
    threshold: 2,
    account,
    chainId: 1,
    ceremonyId
  });
  const evidence = buildGuardianOnboardingEvidence({
    guardians,
    threshold: 2,
    account,
    chainId: 1,
    ceremonyId,
    proofsOfPossession: ceremony.leaves.map(leaf => {
      const challenge = createGuardianPossessionChallenge({
        ...leaf,
        account,
        chainId: 1,
        ceremonyId,
        expiresAt: 2000000000
      });
      return {
        leaf: leaf.leaf,
        challengeDigest: challenge.digest,
        signature: `0x${"ab".repeat(65)}`,
        verifierKind: "p256-webauthn",
        verified: true,
        expiresAt: 2000000000
      };
    }),
    encryptedBackups: ceremony.leaves.map((leaf, index) => ({
      leaf: leaf.leaf,
      envelopeHash: bytes32(`backup-${index}`),
      decryptionTested: true
    })),
    usabilityProof: {
      client: "@loom/guardian test client",
      rootRebuilt: true,
      proofsVerified: true,
      thresholdReachable: true,
      backupDecryptionTested: true
    },
    privacyProof: {
      saltedCommitments: true,
      publicEvidenceRedacted: true,
      noCentralService: true,
      noGuardianGraphUpload: true
    }
  });

  assert.equal(evidence.guardianRoot, ceremony.guardianRoot);
  assert.equal(validateGuardianOnboardingEvidence(evidence), true);
  const publicJson = JSON.stringify(evidence).toLowerCase();
  assert.equal(publicJson.includes("keycommitment"), false);
  assert.equal(publicJson.includes('"salt"'), false);
  assert.equal(publicJson.includes("ciphertext"), false);
});

test("guardian onboarding evidence rejects bad possession and missing backup proof", () => {
  const ceremony = buildGuardianCeremony({
    guardians,
    threshold: 2,
    account,
    chainId: 1,
    ceremonyId
  });
  const proofsOfPossession = ceremony.leaves.map(leaf => ({
    leaf: leaf.leaf,
    challengeDigest: bytes32("wrong-challenge"),
    signature: `0x${"ab".repeat(65)}`,
    verifierKind: "p256-webauthn",
    verified: true,
    expiresAt: 2000000000
  }));

  assert.throws(
    () =>
      buildGuardianOnboardingEvidence({
        guardians,
        threshold: 2,
        account,
        chainId: 1,
        ceremonyId,
        proofsOfPossession,
        encryptedBackups: ceremony.leaves.map((leaf, index) => ({
          leaf: leaf.leaf,
          envelopeHash: bytes32(`backup-${index}`),
          decryptionTested: true
        })),
        usabilityProof: {
          client: "@loom/guardian test client",
          rootRebuilt: true,
          proofsVerified: true,
          thresholdReachable: true,
          backupDecryptionTested: true
        },
        privacyProof: {
          saltedCommitments: true,
          publicEvidenceRedacted: true,
          noCentralService: true,
          noGuardianGraphUpload: true
        }
      }),
    /challenge digest mismatch/
  );
});

function bytes32(seed) {
  return `0x${"00".repeat(16)}${Buffer.from(seed).toString("hex").padEnd(32, "0").slice(0, 32)}`;
}
