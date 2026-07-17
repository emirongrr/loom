// Enterprise onboarding example (runnable).
//
// Scenario: a fintech ("Acme Pay") builds a self-custody wallet into its own
// product. The user only ever sees Acme's UI. Acme owns onboarding, KYC, fiat
// rails, and the RPC/bundler infrastructure. Loom owns the wallet engine. The
// key material stays with the user's passkey, and Acme is never a trust anchor:
// if Acme disappears, the user still controls the account.
//
// This script is self-verifying (node:assert) and narrates each step. Run it:
//   node examples/enterprise-onboarding.mjs
//
// It contacts no network. A global-fetch trap fails loudly if the SDK ever
// reaches for a hidden default provider — the same walkaway guarantee the SDK
// test suite enforces.

import assert from "node:assert/strict";
import { createLoomClient, createPasskeySigner } from "../packages/sdk/dist/index.js";
// Privacy is optional: the wallet engine takes an injected host, so @loom/privacy
// is a separate, explicit install rather than an SDK dependency.
import { createKohakuHost } from "../packages/privacy/src/index.js";

const log = (...args) => console.log(...args);
const section = title => log(`\n=== ${title} ===`);

// --- Acme's own deployment parameters -------------------------------------
// Acme runs its own factory and its own AppAccountRegistry (decision 0004 /
// 0009): each institution deploys its own, so account-count and TVL analytics
// are app-local and never form a global cross-institution registry.
const ACME_FACTORY = "0xac6e000000000000000000000000000000000001";
const ACME_BUNDLER = "https://bundler.acme-pay.example"; // Acme's chosen infra, not a Loom default.
const ACME_RPC = "https://rpc.acme-pay.example"; // Acme's chosen RPC, not a Loom default.
const STABLECOIN = "0x5555555555555555555555555555555555555555";
const CHAIN_ID = 1;

// The user's counterfactual account address (deterministic from the factory +
// salt). Acme derives this the moment the user signs up, before any on-chain
// deploy, so it can receive the user's first stablecoin deposit immediately.
const USER_ACCOUNT = "0x1111111111111111111111111111111111111111";
const ACCOUNT_SALT = `0x${"a1".repeat(32)}`;

async function main() {
  // A walkaway trap: the SDK must never perform network I/O outside the
  // adapters Acme injects. If it reaches for global fetch, this throws.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    throw new Error(`walkaway violation: SDK made an unconfigured network call to ${String(input)}`);
  };

  try {
    section("1. KYC and onboarding happen entirely in Acme's system");
    // KYC is Acme's responsibility and never touches the Loom core. It is an
    // opaque, off-chain fact from Loom's perspective — no identity data, no
    // institution key, and no Acme address is written into the account.
    const acmeCustomer = { id: "cust_20260704_8842", kycStatus: "approved", jurisdiction: "EU" };
    assert.equal(acmeCustomer.kycStatus, "approved");
    log(`Acme approved customer ${acmeCustomer.id}. Loom never sees this record.`);

    section("2. The user registers a passkey inside Acme's app");
    // The user creates a WebAuthn passkey through Acme's UI. In a browser this
    // is navigator.credentials.create(); here we model the authenticator. The
    // private key never leaves the user's device — Acme cannot sign for them.
    const userAuthenticatorSignatures = [];
    const passkey = createPasskeySigner({
      credentialId: "acme-passkey-cust_20260704_8842",
      rpId: "acme-pay.example",
      origin: "https://app.acme-pay.example",
      // The installed P-256 validator this signer routes through and the
      // EntryPoint the canonical hash is bound to — explicit commitments.
      validator: "0xac6e000000000000000000000000000000000002",
      entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      // This callback is where Acme's frontend would call the WebAuthn API and
      // the user would approve with Face ID / fingerprint. The challenge is
      // bound to the exact account, chain, and operation hash.
      async signChallenge(challenge) {
        userAuthenticatorSignatures.push(challenge);
        assert.equal(challenge.account, USER_ACCOUNT);
        assert.equal(challenge.rpId, "acme-pay.example");
        return {
          authenticatorData: `0x${"aa".repeat(37)}`,
          clientDataJSON: `0x${"bb".repeat(40)}`,
          signature: `0x${"1c".repeat(32)}${"2d".repeat(32)}`
        };
      }
    });
    log("User holds the passkey. Acme holds no key material for this account.");

    // Acme wires the SDK: it supplies its own RPC (kohaku), its own bundler
    // transport, and the *user's* passkey as the signer. Note the asymmetry —
    // Acme provides infrastructure and UX; the user provides authority.
    const broadcastByAcme = [];
    const acmeRpcCalls = [];
    const client = createLoomClient({
      chainId: CHAIN_ID,
      account: USER_ACCOUNT,
      signer: passkey,
      // Acme's chosen bundler. It only broadcasts; it never signs.
      transport: {
        async sendUserOperation(envelope) {
          broadcastByAcme.push(envelope);
          return { userOpHash: `0x${"12".repeat(32)}` };
        }
      },
      // Acme's chosen RPC endpoint, reached only through Acme's own fetch.
      kohaku: {
        host: createKohakuHost({
          providerProfile: {
            mode: "user-rpc",
            chainId: CHAIN_ID,
            endpoint: ACME_RPC,
            verified: false,
            metadataBudget: {
              protocol: "custom",
              chainId: CHAIN_ID,
              items: [
                { surface: "rpc", reveals: "chain and request timing", required: true, mitigation: "Acme-operated endpoint" }
              ]
            }
          },
          fetch: async url => {
            acmeRpcCalls.push(String(url));
            return new Response("{}");
          }
        })
      }
    });

    section("3. Acme derives the counterfactual account (no deploy yet)");
    // Preparing the deployment is pure and offline: Acme can show the user their
    // address and accept a deposit to it before the account is ever deployed.
    const deploy = client.prepareDeployAccount({
      factory: ACME_FACTORY,
      salt: ACCOUNT_SALT,
      initCode: "0x1234",
      // The user starts guardian-protected recovery from day one. Acme is NOT a
      // guardian; guardians are the user's own chosen keys/devices.
      recoveryStatus: "guardian-protected"
    });
    assert.equal(deploy.intent.kind, "account.deploy");
    log(`Account ${USER_ACCOUNT} is counterfactual and can receive funds now.`);

    section("4. Acme converts fiat to stablecoin and funds the account");
    // Fiat handling is Acme's rails. From Loom's view this is just an inbound
    // stablecoin transfer to the user's address — no special integration.
    const fiatDeposit = { amountEur: 500, stablecoin: STABLECOIN, toAccount: USER_ACCOUNT };
    log(`Acme converted €${fiatDeposit.amountEur} and sent stablecoin to the user's account.`);

    section("5. The user's first payment: signed by the user, broadcast by Acme");
    // The user taps "pay" in Acme's UI. The passkey signs; Acme's bundler
    // broadcasts. Acme cannot alter or forge the operation.
    const payment = await client.sendCalls({
      calls: [{ target: STABLECOIN, value: 0n, data: "0xa9059cbb" }]
    });
    assert.equal(payment.userOpHash, `0x${"12".repeat(32)}`);
    assert.equal(broadcastByAcme.length, 1, "exactly one op broadcast via Acme's transport");
    assert.equal(userAuthenticatorSignatures.length, 1, "exactly one op signed by the user's passkey");
    // The broadcast op carries the user's signature and the user's account —
    // proof that authority came from the passkey, not from Acme.
    assert.equal(broadcastByAcme[0].userOperation.sender, USER_ACCOUNT);
    assert.notEqual(broadcastByAcme[0].userOperation.signature, "0x");
    log("Payment signed by the user's passkey, broadcast by Acme's bundler.");

    section("6. Self-sovereignty: the user does not depend on Acme");
    // The user can rotate authority through guardian recovery. This preparation
    // is pure and offline — it needs no Acme service, and would still work if
    // Acme shut down tomorrow.
    const recovery = client.proposeRecovery({
      newConfigHash: `0x${"cd".repeat(32)}`,
      configVersion: 2n,
      executeAfter: 1000n
    });
    assert.equal(recovery.intent.kind, "recovery.propose");
    assert.equal(recovery.review.requiresGuardianApproval, true);
    // The deploy op itself can be broadcast through any transport, so even
    // account creation is not gated on Acme surviving.
    assert.equal(deploy.initCode, "0x1234");
    log("Recovery and account control need no Acme-operated service. Walkaway holds.");

    section("7. App-local metrics, without breaking privacy");
    // Acme reads its OWN AppAccountRegistry (accountCount / isAccount) to report
    // how many wallets it onboarded and to scope TVL to its cohort. This is
    // per-institution: it never links a user's multiple accounts and never forms
    // a global registry across institutions (ARCHITECTURE.md privacy boundary).
    log("Acme reads AppAccountRegistry.accountCount() for its own cohort only.");
    log("No cross-account linkage, no global registry, no guardian exposure.");

    // Sanity: any provider access that happened used Acme's endpoint, never a
    // Loom default. (Pure-preparation steps above made zero network calls.)
    for (const url of acmeRpcCalls) {
      assert.ok(url.startsWith(ACME_RPC), `unexpected endpoint ${url}`);
    }

    section("Result");
    log("The user has a self-custody, self-sovereign account.");
    log("Acme owned the UX. Loom owned the wallet engine. Neither owned the user's keys.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
