import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { decodeAbiParameters, keccak256, stringToHex } from "viem";
import { base64UrlEncode } from "@loom/passkey";
import { computeUserOperationHash } from "@loom/sdk";
import {
  grantSession,
  reconnectPasskeyAccount,
  registerPasskeyAccount,
  revokeSession,
  walletClient,
  walletSigner
} from "../src/wallet.mjs";

const RP_ID = "wallet.example";
const ORIGIN = "https://wallet.example";
const CHAIN_ID = 31337;

// The deployment a wallet is configured against (from a Loom deployment
// manifest in a real app).
const deployment = {
  entryPoint: "0x433709e09c7750b04c222fb46e0f27642f41f0b7",
  factory: "0x610178da211fef7d417bc0e6fed39f05609ad788",
  implementation: "0x2222222222222222222222222222222222222222",
  validator: "0x3333333333333333333333333333333333333333",
  policyHook: "0x4444444444444444444444444444444444444444",
  proxyCreationCode: `0x${"60".repeat(64)}`
};

// A software P-256 authenticator standing in for `navigator.credentials`, so
// the whole browser flow is deterministic in CI. index.html wires the real one.
function softwareCredentials() {
  const keys = new Map();
  const seen = [];
  return {
    seen,
    async create({ rpId, userName }) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = publicKey.export({ format: "jwk" });
      const pad = value => `0x${Buffer.from(value, "base64url").toString("hex").padStart(64, "0")}`;
      const credentialId = `0x${crypto.randomBytes(16).toString("hex")}`;
      keys.set(credentialId, privateKey);
      seen.push({ op: "create", rpId, userName });
      return { credentialId, publicKeyX: pad(jwk.x), publicKeyY: pad(jwk.y) };
    },
    async get({ credentialId, rpId, origin, challenge }) {
      const privateKey = keys.get(credentialId);
      if (!privateKey) throw new Error("unknown credential");
      seen.push({ op: "get", credentialId, rpId, origin, challenge });
      // A real authenticator puts sha256(rpId) here. Hashing it any other way
      // would make this fake agree with a registration that the on-chain
      // validator rejects, which is exactly the bug this must not hide.
      const rpIdHash = crypto.createHash("sha256").update(rpId).digest();
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05])]);
      const clientDataJSON = Buffer.from(`{"type":"webauthn.get","challenge":"${challenge}","origin":"${origin}","crossOrigin":false}`, "utf8");
      const preimage = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
      const signature = crypto.sign("sha256", preimage, { key: privateKey, dsaEncoding: "ieee-p1363" });
      return {
        authenticatorData: `0x${authenticatorData.toString("hex")}`,
        clientDataJSON: `0x${clientDataJSON.toString("hex")}`,
        signature: `0x${signature.toString("hex")}`
      };
    }
  };
}

const register = credentials =>
  registerPasskeyAccount({ credentials, rpId: RP_ID, origin: ORIGIN, userName: "alice", chainId: CHAIN_ID, deployment });

test("registration creates a passkey and derives a counterfactual account", async () => {
  const credentials = softwareCredentials();
  const wallet = await register(credentials);

  assert.match(wallet.account, /^0x[0-9a-fA-F]{40}$/, "an account address was derived");
  assert.match(wallet.credentialId, /^0x[0-9a-f]{32}$/);
  assert.equal(wallet.rpId, RP_ID);
  assert.equal(wallet.validator, deployment.validator);
  // The account is counterfactual: derivation happened locally, no chain call.
  assert.equal(credentials.seen.filter(s => s.op === "create").length, 1);
  assert.equal(credentials.seen.some(s => s.op === "get"), false, "registration does not prompt for an assertion");
});

test("reconnecting from the stored public key re-derives the same account", async () => {
  const credentials = softwareCredentials();
  const first = await register(credentials);

  // A later visit: only the persisted handle is available — no new passkey.
  const again = reconnectPasskeyAccount({
    deployment,
    rpId: RP_ID,
    origin: ORIGIN,
    chainId: CHAIN_ID,
    credentialId: first.credentialId,
    publicKey: first.publicKey
  });

  assert.equal(again.account, first.account, "the same passkey derives the same account");
  assert.equal(again.salt, first.salt);
  assert.deepEqual(again.config, first.config);
  assert.equal(credentials.seen.filter(s => s.op === "create").length, 1, "reconnect did not register again");
});

test("a different passkey derives a different account", async () => {
  const credentials = softwareCredentials();
  const a = await register(credentials);
  const b = await register(credentials);
  assert.notEqual(a.account, b.account);
});

test("the passkey signer signs the canonical hash into a validator envelope", async () => {
  const credentials = softwareCredentials();
  const wallet = await register(credentials);
  const signer = walletSigner({ credentials, wallet });

  const hash = `0x${"ab".repeat(32)}`;
  const signature = await signer.sign(hash);

  // The authenticator was asked to sign exactly base64url(hash) for this origin.
  const assertionCall = credentials.seen.find(s => s.op === "get");
  assert.equal(assertionCall.challenge, base64UrlEncode(hash));
  assert.equal(assertionCall.origin, ORIGIN);
  assert.equal(assertionCall.credentialId, wallet.credentialId);

  // The result is the account-level (validator, validatorSignature) envelope.
  const [validator, validatorSignature] = decodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    signature
  );
  assert.equal(validator.toLowerCase(), deployment.validator.toLowerCase());
  assert.ok(validatorSignature.length > 2, "the WebAuthn signature struct is present");
});

test("the wallet client prepares an operation the passkey then signs", async () => {
  const credentials = softwareCredentials();
  const wallet = await register(credentials);
  const client = walletClient({ credentials, wallet, computeUserOperationHash });

  const prepared = client.prepareCalls({
    calls: [{ target: "0x5555555555555555555555555555555555555555", value: 0n, data: "0x1234" }]
  });
  assert.equal(prepared.kind, "account.calls.prepare");

  const envelope = client.prepareUserOperation(prepared, {
    nonce: 0n,
    callGasLimit: 500_000n,
    verificationGasLimit: 800_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n
  });
  assert.equal(envelope.kind, "userOperation.prepare");
  assert.equal(envelope.userOperation.sender.toLowerCase(), wallet.account.toLowerCase());

  // The passkey signs the canonical hash of exactly that envelope.
  const hash = computeUserOperationHash(envelope, { entryPoint: deployment.entryPoint });
  const signature = await walletSigner({ credentials, wallet }).sign(hash);
  const [validator] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }], signature);
  assert.equal(validator.toLowerCase(), deployment.validator.toLowerCase());
  assert.equal(credentials.seen.at(-1).challenge, base64UrlEncode(hash));
});

test("a session is granted with an explicit scope and revoked by key", async () => {
  const credentials = softwareCredentials();
  const wallet = await register(credentials);
  const client = walletClient({ credentials, wallet, computeUserOperationHash });
  const sessionKey = "0x6666666666666666666666666666666666666666";

  const grant = grantSession(client, {
    origin: "https://app.example",
    sessionKey,
    target: "0x5555555555555555555555555555555555555555",
    selector: "0x12345678",
    token: "0x7777777777777777777777777777777777777777",
    maxAmount: 100n,
    validUntil: 2_000_000_000n,
    maxUses: 5
  });
  assert.equal(grant.kind, "session.grant.prepare");
  assert.equal(grant.intent.kind, "session.grant");
  assert.equal(grant.intent.sessionKey.toLowerCase(), sessionKey);
  // The grant is app-scoped and requires the user's signature.
  assert.equal(grant.intent.authority.requiresUserSignature, true);

  const revoke = revokeSession(client, sessionKey);
  assert.equal(revoke.kind, "session.revoke.prepare");
  assert.equal(revoke.intent.kind, "session.revoke");
  assert.equal(revoke.intent.sessionKey.toLowerCase(), sessionKey);
});

// The account's registered rpIdHash must equal the rpId hash a real
// authenticator actually puts in authenticatorData, because the on-chain
// validator compares those two directly (WebAuthnP256.verify). Registering a
// differently-hashed rpId produces an account that derives fine, signs fine,
// and is rejected on chain with AA24 — a failure no local flow can surface,
// so it is pinned here.
test("the registered rpIdHash matches what the authenticator reports", async () => {
  const credentials = softwareCredentials();
  const wallet = await register(credentials);

  const validatorModule = wallet.config.modules.find(module => module.moduleTypeId === 1n);
  const [, , registeredRpIdHash, registeredOriginHash] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
    `0x${validatorModule.initData.slice(10)}`
  );

  const assertion = await credentials.get({
    credentialId: wallet.credentialId, rpId: RP_ID, origin: ORIGIN, challenge: base64UrlEncode(`0x${"11".repeat(32)}`)
  });
  const reportedRpIdHash = `0x${assertion.authenticatorData.slice(2, 66)}`;

  assert.equal(registeredRpIdHash, reportedRpIdHash, "registered rpIdHash must equal authenticatorData[0:32]");
  // The origin is hashed by the validator itself, so it stays keccak.
  assert.equal(registeredOriginHash, keccak256(stringToHex(ORIGIN)));
});
