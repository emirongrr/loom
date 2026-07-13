// Individual wallet example (runnable).
//
// The same Loom core that powers an institution also serves a solo user with no
// company behind them. Here one person runs a passkey wallet and sets up
// guardian-based social recovery themselves, using their own RPC and bundler.
// There is no admin, no institution, and no Loom-operated service.
//
// Self-verifying (node:assert) and narrated. Run it:
//   node examples/individual-passkey-wallet.mjs

import assert from "node:assert/strict";
import { createLoomClient, createPasskeySigner } from "../packages/sdk/src/index.js";
import { buildGuardianCeremony, verifyGuardianProof } from "../packages/guardian/src/index.js";
// Privacy is optional: the wallet engine takes an injected host, so @loom/privacy
// is a separate, explicit install rather than an SDK dependency.
import { createKohakuHost } from "../packages/privacy/src/index.js";

const log = (...args) => console.log(...args);
const section = title => log(`\n=== ${title} ===`);

const CHAIN_ID = 1;
const USER_ACCOUNT = "0x2222222222222222222222222222222222222222";
const USER_FACTORY = "0x3333333333333333333333333333333333333333";
const ACCOUNT_SALT = `0x${"b2".repeat(32)}`;
const USER_RPC = "https://rpc.my-own-node.example"; // the user's own node, their choice.

async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    throw new Error(`walkaway violation: SDK made an unconfigured network call to ${String(input)}`);
  };

  try {
    section("1. The user creates a passkey");
    // A single WebAuthn passkey on the user's own device. No seed phrase to
    // write down; the authenticator holds the key.
    const passkey = createPasskeySigner({
      credentialId: "solo-user-passkey",
      rpId: "my-wallet.example",
      origin: "https://my-wallet.example",
      // The installed P-256 validator and the EntryPoint the hash binds to.
      validator: "0x00000000000000000000000000000000000000f2",
      entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      async signChallenge(challenge) {
        assert.equal(challenge.account, USER_ACCOUNT);
        return {
          authenticatorData: `0x${"aa".repeat(37)}`,
          clientDataJSON: `0x${"bb".repeat(40)}`,
          signature: `0x${"1c".repeat(32)}${"2d".repeat(32)}`
        };
      }
    });

    const broadcast = [];
    const client = createLoomClient({
      chainId: CHAIN_ID,
      account: USER_ACCOUNT,
      signer: passkey,
      transport: {
        async sendUserOperation(envelope) {
          broadcast.push(envelope);
          return { userOpHash: `0x${"34".repeat(32)}` };
        }
      },
      kohaku: {
        host: createKohakuHost({
          providerProfile: {
            mode: "user-rpc",
            chainId: CHAIN_ID,
            endpoint: USER_RPC,
            verified: false,
            metadataBudget: {
              protocol: "custom",
              chainId: CHAIN_ID,
              items: [{ surface: "rpc", reveals: "chain and timing", required: true, mitigation: "self-hosted node" }]
            }
          },
          fetch: async () => new Response("{}")
        })
      }
    });
    log("Passkey created. The user controls the account directly.");

    section("2. The user sets up social recovery with their own guardians");
    // The user picks three guardians (e.g. a hardware key, a friend's wallet, a
    // backup device) and requires any two to recover. Guardians are built and
    // verified entirely client-side; the guardian root commits to them without
    // revealing who they are on-chain.
    const guardians = [
      { verifier: "0x00000000000000000000000000000000000000a1", verifierCodeHash: `0x${"d1".repeat(32)}`, keyCommitment: `0x${"e1".repeat(32)}`, salt: `0x${"f1".repeat(32)}` },
      { verifier: "0x00000000000000000000000000000000000000a2", verifierCodeHash: `0x${"d2".repeat(32)}`, keyCommitment: `0x${"e2".repeat(32)}`, salt: `0x${"f2".repeat(32)}` },
      { verifier: "0x00000000000000000000000000000000000000a3", verifierCodeHash: `0x${"d3".repeat(32)}`, keyCommitment: `0x${"e3".repeat(32)}`, salt: `0x${"f3".repeat(32)}` }
    ];
    const ceremony = buildGuardianCeremony({ guardians, threshold: 2, account: USER_ACCOUNT, chainId: CHAIN_ID });
    assert.equal(ceremony.threshold, 2);
    assert.equal(ceremony.guardianCount, 3);
    // Each guardian gets a Merkle proof of membership; anyone can verify a proof
    // against the committed root without learning the other guardians.
    for (const { leaf, proof } of ceremony.proofs) {
      assert.equal(verifyGuardianProof({ root: ceremony.guardianRoot, leaf, proof }), true);
    }
    log(`Guardian set committed: ${ceremony.threshold}-of-${ceremony.guardianCount}, root ${ceremony.guardianRoot.slice(0, 10)}...`);

    section("3. The user deploys guardian-protected, then transacts");
    const deploy = client.prepareDeployAccount({
      factory: USER_FACTORY,
      salt: ACCOUNT_SALT,
      initCode: "0x5678",
      recoveryStatus: "guardian-protected"
    });
    assert.equal(deploy.intent.kind, "account.deploy");

    const sent = await client.sendCalls({ calls: [{ target: USER_ACCOUNT, value: 0n, data: "0x" }] });
    assert.equal(sent.userOpHash, `0x${"34".repeat(32)}`);
    assert.equal(broadcast.length, 1);
    assert.equal(broadcast[0].userOperation.sender, USER_ACCOUNT);
    log("Account deployed guardian-protected and the first operation went out.");

    section("4. Recovery after a lost device — no service required");
    // If the user loses their passkey device, the guardians (any 2 of 3) rotate
    // the account to a new key. Preparing the proposal is pure and offline; the
    // multi-day delay and guardian threshold are enforced on-chain by the core.
    const recovery = client.proposeRecovery({
      newConfigHash: `0x${"77".repeat(32)}`,
      configVersion: 2n,
      executeAfter: 1000n
    });
    assert.equal(recovery.intent.kind, "recovery.propose");
    assert.equal(recovery.review.requiresGuardianApproval, true);
    log("Guardians can rotate authority. No Loom service, no admin, no seed phrase.");

    section("Result");
    log("One person, one passkey, self-chosen guardians — full self-custody on the same core.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
