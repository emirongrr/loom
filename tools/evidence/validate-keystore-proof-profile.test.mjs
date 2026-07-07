import test from "node:test";
import assert from "node:assert/strict";
import sha3 from "js-sha3";
import { validateKeystoreProofProfile } from "./validate-keystore-proof-profile.mjs";

const { keccak_256 } = sha3;

test("keystore proof profile accepts direct Ethereum L1 verifier evidence", () => {
  validateKeystoreProofProfile(ethereumProfile());
});

test("keystore proof profile rejects L1 messaging, bridges, or Loom service authority", () => {
  const messaging = ethereumProfile();
  messaging.proof.usesL1ToL2Messaging = true;
  assert.throws(() => validateKeystoreProofProfile(messaging), /usesL1ToL2Messaging must be false/);

  const bridge = ethereumProfile();
  bridge.proof.usesBridgeAttestation = true;
  assert.throws(() => validateKeystoreProofProfile(bridge), /usesBridgeAttestation must be false/);

  const service = ethereumProfile();
  service.proof.usesLoomService = true;
  assert.throws(() => validateKeystoreProofProfile(service), /usesLoomService must be false/);
});

test("keystore proof profile rejects unaudited or upgradeable verifiers", () => {
  const unaudited = ethereumProfile();
  unaudited.verifier.audited = false;
  assert.throws(() => validateKeystoreProofProfile(unaudited), /verifier.audited must be true/);

  const upgradeable = ethereumProfile();
  upgradeable.verifier.upgradeable = true;
  assert.throws(() => validateKeystoreProofProfile(upgradeable), /verifier.upgradeable must be false/);
});

test("keystore proof profile accepts audited OP Stack storage-proof profile", () => {
  validateKeystoreProofProfile(opStackProfile());
});

test("keystore proof profile rejects l2 profiles without state-root and finality evidence", () => {
  const missingStateRoot = opStackProfile();
  delete missingStateRoot.proof.stateRootSource;
  assert.throws(() => validateKeystoreProofProfile(missingStateRoot), /stateRootSource is required/);

  const missingAudit = opStackProfile();
  missingAudit.checks.independentAuditCompleted = false;
  assert.throws(() => validateKeystoreProofProfile(missingAudit), /independentAuditCompleted/);
});

test("keystore proof profile rejects chain-family verifier mismatches", () => {
  const profile = opStackProfile();
  profile.verifier.kind = "same-chain-l1-direct-read";
  assert.throws(() => validateKeystoreProofProfile(profile), /verifier.kind must be op-stack-l1-storage-proof/);
});

function ethereumProfile() {
  return {
    version: 1,
    network: {
      name: "ethereum",
      family: "ethereum",
      chainId: 1,
      l1ChainId: 1
    },
    l1Keystore: {
      address: address("keystore"),
      runtimeCodeHash: bytes32("keystore-runtime"),
      deploymentBlock: 123456,
      upgradeable: false
    },
    verifier: {
      kind: "same-chain-l1-direct-read",
      address: address("verifier"),
      runtimeCodeHash: bytes32("verifier-runtime"),
      upgradeable: false,
      audited: true,
      auditReport: "docs/security/audit-scope.md"
    },
    proof: {
      authority: "ethereum-l1-state",
      encoding: "empty",
      finality: {
        kind: "same-transaction-state"
      },
      usesL1ToL2Messaging: false,
      usesBridgeAttestation: false,
      usesOracle: false,
      usesLoomService: false,
      negativeTestVectors: [
        "missing identity",
        "wrong keystore",
        "non-empty proof",
        "wrong version",
        "wrong config root"
      ]
    },
    checks: passingChecks()
  };
}

function opStackProfile() {
  const profile = ethereumProfile();
  profile.network = {
    name: "base",
    family: "op-stack",
    chainId: 8453,
    l1ChainId: 1
  };
  profile.verifier.kind = "op-stack-l1-storage-proof";
  profile.proof.encoding = "ethereum-storage-proof";
  profile.proof.finality = {
    kind: "l1-finalized-state-root",
    minDelaySeconds: 604800,
    minL1Confirmations: 2
  };
  profile.proof.stateRootSource = {
    family: "op-stack",
    contract: address("l1-block")
  };
  profile.checks.independentAuditCompleted = true;
  return profile;
}

function passingChecks() {
  return {
    l1KeystoreBytecodeVerified: true,
    verifierBytecodeVerified: true,
    storageSlotDerivationDocumented: true,
    staleVersionRejected: true,
    wrongIdentityRejected: true,
    wrongStorageSlotRejected: true,
    wrongStateRootRejected: true,
    wrongChainRejected: true,
    noMessagingAuthority: true,
    noBridgeAuthority: true,
    noLoomServiceRequired: true
  };
}

function address(seed) {
  return `0x${keccak_256(seed).slice(0, 40)}`;
}

function bytes32(seed) {
  return `0x${keccak_256(seed)}`;
}
