import assert from "node:assert/strict";
import test from "node:test";
import { createLoomClient, explainLifecycleIntent, hashCanonical } from "../src/index.js";

// Randomized SDK session simulation. The unit tests exercise fixed lifecycle
// sequences; this drives thousands of randomly ordered create → grant → recover
// → migrate → cancel sequences through the real client, asserting after every
// step the properties the SDK guarantees:
//
//   • authority-classification consistency — the clear-signing review for each
//     operation matches its kind (guardian-approval, user-signature, delay);
//   • immutability — every prepared intent and its review are frozen, so one
//     step can never mutate a previous step's authority;
//   • determinism — re-preparing an operation with identical inputs yields the
//     identical intent hash;
//   • walkaway — no operation performs network I/O; a hidden default-provider
//     call anywhere in a long session fails the run.
//
// Seeded so a failure is reproducible: the seed is printed in every assertion
// message.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (rng, bytes) => {
  let out = "0x";
  for (let i = 0; i < bytes; i += 1) out += Math.floor(rng() * 256).toString(16).padStart(2, "0");
  return out;
};
const addr = rng => hex(rng, 20);
const b32 = rng => hex(rng, 32);
const selector = rng => hex(rng, 4);
const uint = (rng, max = 1_000_000_000) => BigInt(Math.floor(rng() * max)) + 1n;
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// A user-selected privacy provider profile (own endpoint, not a default). The
// simulation never performs privacy operations, so this only satisfies client
// construction.
const userProviderProfile = () => ({
  mode: "user-rpc",
  chainId: 1,
  endpoint: "https://user.rpc.example",
  verified: false,
  metadataBudget: {
    protocol: "railgun",
    chainId: 1,
    items: [{ surface: "rpc", reveals: "target chain and request timing", required: true, mitigation: "user endpoint" }]
  }
});

function sortedValidators(rng) {
  const set = new Map();
  const n = 1 + Math.floor(rng() * 4);
  while (set.size < n) {
    const a = addr(rng);
    set.set(BigInt(a), a);
  }
  return [...set.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([, a]) => a);
}

// Expected clear-signing authority per lifecycle kind. Mirrors the builder
// classification in @loom/account; a divergence is exactly the bug this catches.
const AUTHORITY = {
  "account.deploy": { user: true, guardian: false, delay: false },
  "account.calls": { user: true, guardian: false, delay: false },
  "session.grant": { user: true, guardian: false, delay: false },
  "session.revoke": { user: true, guardian: false, delay: false },
  "recovery.propose": { user: false, guardian: true, delay: true },
  "recovery.execute": { user: false, guardian: false, delay: true },
  "migration.schedule": { user: true, guardian: false, delay: true },
  "vault.withdrawal.schedule": { user: true, guardian: false, delay: true }
};

// Each op builds valid random inputs and prepares the operation through the
// client. Route-dependent cancels are asserted separately from the table.
function operations(client) {
  return [
    {
      inputs: rng => ({ calls: [{ target: addr(rng), value: uint(rng), data: hex(rng, 1 + Math.floor(rng() * 40)) }] }),
      run: i => client.prepareCalls(i)
    },
    {
      inputs: rng => ({
        origin: `https://app-${Math.floor(rng() * 1e6)}.example`,
        sessionKey: addr(rng),
        target: addr(rng),
        selector: selector(rng),
        token: addr(rng),
        maxAmount: uint(rng),
        validUntil: uint(rng, 4_000_000_000),
        maxUses: 1 + Math.floor(rng() * 100)
      }),
      run: i => client.grantSession(i)
    },
    {
      inputs: rng => ({ sessionKey: addr(rng) }),
      run: i => client.revokeSession(i)
    },
    {
      inputs: rng => ({ newConfigHash: b32(rng), configVersion: uint(rng), executeAfter: uint(rng, 4_000_000_000) }),
      run: i => client.proposeRecovery(i)
    },
    {
      inputs: rng => {
        const executeAfter = uint(rng, 4_000_000_000);
        return {
          recoveryId: b32(rng),
          oldValidators: sortedValidators(rng),
          newValidator: addr(rng),
          initDataHash: b32(rng),
          newGuardianRoot: b32(rng),
          newGuardianThreshold: 1 + Math.floor(rng() * 32),
          executeAfter,
          expiresAt: executeAfter + uint(rng, 4_000_000_000)
        };
      },
      run: i => client.executeRecovery(i)
    },
    {
      inputs: rng => ({
        token: addr(rng),
        recipient: addr(rng),
        amount: uint(rng),
        executeAfter: uint(rng, 4_000_000_000)
      }),
      run: i => client.scheduleVaultWithdrawal(i)
    },
    {
      inputs: rng => ({
        destination: addr(rng),
        destinationCodeHash: b32(rng),
        delaySeconds: 1 + Math.floor(rng() * 1_000_000)
      }),
      run: i => {
        const intent = client.sdk.lifecycle.buildMigration({ account: client.account, chainId: client.chainId, ...i });
        return Object.freeze({
          kind: "migration.schedule.prepare",
          intent,
          intentHash: hashCanonical(intent),
          review: explainLifecycleIntent(intent)
        });
      }
    }
  ];
}

// Route-dependent cancellations: assert user/guardian flags follow the route.
function cancellations(client) {
  return [
    {
      inputs: rng => ({
        recoveryId: b32(rng),
        configVersion: uint(rng),
        nonce: uint(rng),
        route: pick(rng, ["account", "guardian"])
      }),
      run: i => client.cancelRecovery(i)
    }
  ];
}

function reviewOf(prepared) {
  return prepared.review ?? prepared.intent.review ?? prepared.intent.authority;
}

function kindOf(prepared) {
  return prepared.intent.kind ?? prepared.kind;
}

function assertPreparedShape(prepared, seed, label) {
  const msg = suffix => `${label} (seed ${seed}): ${suffix}`;
  assert.match(prepared.intentHash, /^0x[0-9a-f]{64}$/, msg("intent hash is not a 32-byte hex string"));
  assert.ok(Object.isFrozen(prepared), msg("prepared result is not frozen"));
  assert.ok(Object.isFrozen(prepared.intent), msg("prepared intent is not frozen"));
  assert.ok(Object.isFrozen(reviewOf(prepared)), msg("prepared review is not frozen"));
}

function assertAuthority(prepared, seed, label) {
  const review = reviewOf(prepared);
  const kind = kindOf(prepared);
  const expected = AUTHORITY[kind];
  if (!expected) return; // route-dependent kinds are checked by the caller
  const msg = suffix => `${label} ${kind} (seed ${seed}): ${suffix}`;
  assert.equal(Boolean(review.requiresUserSignature), expected.user, msg("requiresUserSignature mismatch"));
  assert.equal(Boolean(review.requiresGuardianApproval), expected.guardian, msg("requiresGuardianApproval mismatch"));
  assert.equal(Boolean(review.delayRequired), expected.delay, msg("delayRequired mismatch"));
  // A guardian-approval operation must always be delayed, and no operation may
  // demand both a user signature and guardian approval.
  if (review.requiresGuardianApproval) assert.ok(review.delayRequired, msg("guardian approval without a delay"));
  assert.ok(
    !(review.requiresUserSignature && review.requiresGuardianApproval),
    msg("operation requires both a user signature and guardian approval")
  );
}

test("randomized SDK sessions preserve authority, immutability, determinism, and walkaway", () => {
  const seed = Number(process.env.LOOM_SESSION_SEED ?? 0x10c0) >>> 0;
  const rng = mulberry32(seed);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    throw new Error(`walkaway violation (seed ${seed}): SDK made a network call to ${String(input)}`);
  };

  let steps = 0;
  try {
    const SESSIONS = 250;
    for (let s = 0; s < SESSIONS; s += 1) {
      const client = createLoomClient({
        chainId: 1 + Math.floor(rng() * 10),
        account: addr(rng),
        kohaku: {
          providerProfile: userProviderProfile(),
          fetch: async () => {
            throw new Error(`walkaway violation (seed ${seed}): kohaku fetch reached`);
          }
        }
      });
      const ops = operations(client);
      const cancels = cancellations(client);
      const STEPS = 5 + Math.floor(rng() * 20);

      for (let k = 0; k < STEPS; k += 1) {
        const op = pick(rng, ops);
        const inputs = op.inputs(rng);
        const prepared = op.run(inputs);
        assertPreparedShape(prepared, seed, "op");
        assertAuthority(prepared, seed, "op");
        // Determinism: identical inputs must reproduce the same intent hash and
        // must not have been mutated by any earlier step.
        assert.equal(op.run(inputs).intentHash, prepared.intentHash, `determinism broke (seed ${seed})`);
        steps += 1;
      }

      // Route-dependent cancellation: flags must follow the chosen route.
      const cancel = pick(rng, cancels);
      const cancelInputs = cancel.inputs(rng);
      const prepared = cancel.run(cancelInputs);
      assertPreparedShape(prepared, seed, "cancel");
      const review = reviewOf(prepared);
      assert.equal(
        Boolean(review.requiresUserSignature),
        cancelInputs.route === "account",
        `cancel route authority mismatch (seed ${seed}, route ${cancelInputs.route})`
      );
      assert.equal(
        Boolean(review.requiresGuardianApproval),
        cancelInputs.route === "guardian",
        `cancel route authority mismatch (seed ${seed}, route ${cancelInputs.route})`
      );
      steps += 1;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(steps > 1000, `expected a long session (>1000 steps), ran ${steps}`);
});

test("malformed lifecycle inputs are rejected without emitting an intent", () => {
  const seed = 0x2bad;
  const rng = mulberry32(seed);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("walkaway violation: rejection path made a network call");
  };
  try {
    const client = createLoomClient({
      chainId: 1,
      account: addr(rng),
      kohaku: {
        providerProfile: userProviderProfile(),
        fetch: async () => {
          throw new Error("kohaku fetch reached");
        }
      }
    });

    const rejects = [
      () => client.grantSession({ sessionKey: "not-an-address", target: addr(rng), selector: selector(rng), token: addr(rng), maxAmount: 1n, validUntil: 10n, maxUses: 1 }),
      () => client.grantSession({ sessionKey: addr(rng), target: addr(rng), selector: selector(rng), token: addr(rng), maxAmount: 1n, validAfter: 100n, validUntil: 10n, maxUses: 1 }),
      () => client.proposeRecovery({ newConfigHash: "0x00", configVersion: 1n, executeAfter: 1n }),
      () => client.executeRecovery({ recoveryId: b32(rng), oldValidators: [], newValidator: addr(rng), initDataHash: b32(rng), newGuardianRoot: b32(rng), newGuardianThreshold: 1, executeAfter: 1n, expiresAt: 2n }),
      () => client.scheduleVaultWithdrawal({ token: addr(rng), recipient: addr(rng), amount: 0n, executeAfter: 1n })
    ];

    for (const [i, r] of rejects.entries()) {
      assert.throws(r, /./, `malformed input ${i} was not rejected`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
