import assert from "node:assert/strict";
import test from "node:test";
import { InvalidLifecycleRequestError, createAccountLifecycleClient } from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const paymaster = "0x4444444444444444444444444444444444444444";
const codeHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const salt = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("account lifecycle client construction has no provider or paymaster side effects", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const revoke = client.buildSessionRevoke({
    sessionKey: other
  });

  assert.equal(revoke.kind, "session.revoke");
  assert.equal(revoke.chainId, 1);
  assert.equal(revoke.account, account);
  assert.equal("paymaster" in revoke, false);
});

test("deployment builder binds factory salt and init code without sending a transaction", () => {
  const client = createAccountLifecycleClient({ chainId: 1 });
  const intent = client.buildAccountDeployment({
    factory: other,
    salt,
    initCode: "0x1234"
  });

  assert.equal(intent.kind, "account.deploy");
  assert.equal(intent.factory, other);
  assert.equal(intent.salt, salt);
  assert.equal(intent.initCode, "0x1234");
  assert.equal(intent.authority.requiresUserSignature, true);
});

test("session grant requires granular target selector token amount time and use bounds", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildSessionGrant({
    sessionKey: other,
    target: other,
    selector: "0x12345678",
    token,
    maxAmount: 100n,
    validAfter: 10n,
    validUntil: 20n,
    maxUses: 3
  });

  assert.equal(intent.kind, "session.grant");
  assert.deepEqual(intent.scope, {
    target: other,
    selector: "0x12345678",
    token,
    maxAmount: 100n,
    validAfter: 10n,
    validUntil: 20n,
    maxUses: 3
  });
  assert.equal(intent.authority.risk, "bounded-session");
});

test("session grant rejects expired or unbounded use scopes", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });

  assert.throws(
    () =>
      client.buildSessionGrant({
        sessionKey: other,
        target: other,
        selector: "0x12345678",
        token,
        maxAmount: 100n,
        validAfter: 20n,
        validUntil: 20n,
        maxUses: 1
      }),
    InvalidLifecycleRequestError
  );

  assert.throws(
    () =>
      client.buildSessionGrant({
        sessionKey: other,
        target: other,
        selector: "0x12345678",
        token,
        maxAmount: 100n,
        validUntil: 20n,
        maxUses: 0
      }),
    InvalidLifecycleRequestError
  );
});

test("recovery proposal is visible delayed and guardian-approved", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildRecoveryProposal({
    newConfigHash: codeHash,
    configVersion: 2n,
    executeAfter: 100n
  });

  assert.equal(intent.kind, "recovery.propose");
  assert.equal(intent.authority.requiresGuardianApproval, true);
  assert.equal(intent.authority.delayRequired, true);
  assert.equal(intent.authority.cancellable, true);
});

test("recovery cancellation binds id version nonce and route", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildRecoveryCancellation({
    recoveryId: codeHash,
    configVersion: 2n,
    nonce: 0n,
    route: "guardian"
  });

  assert.equal(intent.kind, "recovery.cancel");
  assert.equal(intent.recoveryId, codeHash);
  assert.equal(intent.nonce, 0n);
  assert.equal(intent.route, "guardian");
  assert.equal(intent.authority.requiresUserSignature, false);
  assert.equal(intent.authority.requiresGuardianApproval, true);
});

test("recovery execution binds old validator set and init data hash", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildRecoveryExecution({
    recoveryId: codeHash,
    oldValidators: [account, other],
    newValidator: paymaster,
    initDataHash: salt,
    newGuardianRoot: codeHash,
    newGuardianThreshold: 2,
    executeAfter: 100n,
    expiresAt: 200n
  });

  assert.equal(intent.kind, "recovery.execute");
  assert.deepEqual(intent.oldValidators, [account, other]);
  assert.equal(intent.newGuardianThreshold, 2);
  assert.equal(intent.authority.requiresUserSignature, false);
  assert.equal(intent.authority.delayRequired, true);
});

test("migration intent binds destination codehash entry point delay and guardian cancellation", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildMigration({
    destination: other,
    destinationCodeHash: codeHash,
    entryPoint: paymaster,
    delaySeconds: 259200,
    expiry: 999n
  });

  assert.equal(intent.kind, "migration.schedule");
  assert.equal(intent.destinationCodeHash, codeHash);
  assert.equal(intent.delaySeconds, 259200);
  assert.equal(intent.authority.cancellableByGuardian, true);
});

test("migration cancellation and execution bind exact pending migration", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const cancel = client.buildMigrationCancellation({
    migrationId: codeHash,
    configVersion: 3n,
    nonce: 1n,
    route: "account"
  });
  const execute = client.buildMigrationExecution({
    migrationId: codeHash,
    destination: other,
    destinationCodeHash: codeHash,
    destinationConfigHash: salt,
    callsHash: codeHash,
    executeAfter: 100n,
    expiresAt: 200n
  });

  assert.equal(cancel.kind, "migration.cancel");
  assert.equal(cancel.authority.requiresUserSignature, true);
  assert.equal(cancel.authority.requiresGuardianApproval, false);
  assert.equal(execute.kind, "migration.execute");
  assert.equal(execute.destinationConfigHash, salt);
  assert.equal(execute.authority.delayRequired, true);
});

test("vault withdrawal intent requires amount recipient delay and cancellation visibility", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildVaultWithdrawal({
    token,
    recipient: other,
    amount: "1000000",
    executeAfter: 100n
  });

  assert.equal(intent.kind, "vault.withdrawal.schedule");
  assert.equal(intent.amount, 1000000n);
  assert.equal(intent.authority.delayRequired, true);
  assert.equal(intent.authority.cancellable, true);
});

test("vault withdrawal cancellation and execution bind exact withdrawal id", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const cancel = client.buildVaultWithdrawalCancellation({
    withdrawalId: codeHash,
    configVersion: 4n,
    route: "guardian"
  });
  const execute = client.buildVaultWithdrawalExecution({
    withdrawalId: codeHash,
    token,
    recipient: other,
    amount: 1000n,
    executeAfter: 100n,
    expiresAt: 200n,
    callDataHash: salt
  });

  assert.equal(cancel.kind, "vault.withdrawal.cancel");
  assert.equal(cancel.authority.requiresGuardianApproval, true);
  assert.equal(execute.kind, "vault.withdrawal.execute");
  assert.equal(execute.callDataHash, salt);
  assert.equal(execute.authority.delayRequired, true);
});

test("private vault withdrawal binds protocol operation and metadata budget hashes", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildPrivateVaultWithdrawal({
    token,
    recipient: other,
    amount: "1000000",
    executeAfter: 100n,
    privacyProtocol: "railgun",
    privateOperationHash: codeHash,
    metadataBudgetHash: salt
  });

  assert.equal(intent.kind, "vault.privateWithdrawal.schedule");
  assert.equal(intent.privacyProtocol, "railgun");
  assert.equal(intent.privateOperationHash, codeHash);
  assert.equal(intent.metadataBudgetHash, salt);
  assert.equal(intent.authority.risk, "vault-private-withdrawal");
  assert.equal(intent.authority.delayRequired, true);
  assert.equal(intent.authority.metadataBudgetRequired, true);
});

test("private vault withdrawal rejects missing private operation binding", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });

  assert.throws(
    () =>
      client.buildPrivateVaultWithdrawal({
        token,
        recipient: other,
        amount: 1n,
        executeAfter: 100n,
        privacyProtocol: "railgun",
        privateOperationHash: "0x1234",
        metadataBudgetHash: salt
      }),
    InvalidLifecycleRequestError
  );

  assert.throws(
    () =>
      client.buildPrivateVaultWithdrawal({
        token,
        recipient: other,
        amount: 1n,
        executeAfter: 100n,
        privacyProtocol: "",
        privateOperationHash: codeHash,
        metadataBudgetHash: salt
      }),
    InvalidLifecycleRequestError
  );
});

test("paymaster policy requires explicit paymaster token cap and expiry", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });
  const intent = client.buildPaymasterPolicy({
    paymaster,
    token,
    maxTokenAmount: 5000n,
    validUntil: 1000n
  });

  assert.equal(intent.kind, "paymaster.policy");
  assert.equal(intent.paymaster, paymaster);
  assert.equal(intent.authority.optionalInfrastructure, true);
});

test("completion builders reject ambiguous cancellation routes and unordered validator sets", () => {
  const client = createAccountLifecycleClient({ chainId: 1, account });

  assert.throws(
    () =>
      client.buildRecoveryCancellation({
        recoveryId: codeHash,
        configVersion: 1n,
        nonce: 0n,
        route: "operator"
      }),
    InvalidLifecycleRequestError
  );

  assert.throws(
    () =>
      client.buildRecoveryExecution({
        recoveryId: codeHash,
        oldValidators: [other, account],
        newValidator: paymaster,
        initDataHash: salt,
        newGuardianRoot: codeHash,
        newGuardianThreshold: 2,
        executeAfter: 100n,
        expiresAt: 200n
      }),
    InvalidLifecycleRequestError
  );
});
