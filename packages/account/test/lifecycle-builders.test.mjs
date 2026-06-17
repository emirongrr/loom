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
