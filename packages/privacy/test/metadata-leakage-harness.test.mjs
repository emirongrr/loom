import assert from "node:assert/strict";
import test from "node:test";
import {
  MetadataBudgetExceededError,
  assertMetadataBudgetAllowed,
  createMetadataLeakageHarness
} from "../src/index.js";

const baseBudget = {
  protocol: "railgun",
  chainId: 1,
  items: [
    {
      surface: "rpc",
      reveals: "selected chain and request timing",
      required: true,
      mitigation: "user-selected endpoint"
    }
  ]
};

test("metadata leakage harness approves bounded mitigated surfaces", () => {
  const harness = createMetadataLeakageHarness({
    allowedSurfaces: ["rpc", "indexer"],
    requireKnownMitigation: true,
    maxRequiredSurfaces: 2
  });

  const review = harness.reviewBudget({
    ...baseBudget,
    items: [
      baseBudget.items[0],
      {
        surface: "indexer",
        reveals: "private note sync window",
        required: true,
        mitigation: "incremental local checkpoints"
      }
    ]
  });

  assert.equal(review.approved, true);
  assert.equal(review.requiredSurfaceCount, 2);
  assert.deepEqual(review.surfaces, ["rpc", "indexer"]);
  assert.deepEqual(review.violations, []);
});

test("metadata leakage harness rejects forbidden relayer surfaces", () => {
  const harness = createMetadataLeakageHarness({
    allowedSurfaces: ["rpc"],
    forbiddenSurfaces: ["relayer"]
  });

  const review = harness.reviewBudget({
    ...baseBudget,
    items: [
      {
        surface: "relayer",
        reveals: "submission timing and fee intent",
        required: true,
        mitigation: "optional user-selected relayer"
      }
    ]
  });

  assert.equal(review.approved, false);
  assert.equal(review.violations[0].code, "forbidden-surface");
});

test("metadata leakage harness rejects secret material in reveal descriptions", () => {
  const harness = createMetadataLeakageHarness({
    allowedSurfaces: ["backup"]
  });

  const review = harness.reviewBudget({
    ...baseBudget,
    items: [
      {
        surface: "backup",
        reveals: "viewing key export",
        required: true,
        mitigation: "local encrypted backup"
      }
    ]
  });

  assert.equal(review.approved, false);
  assert.equal(review.violations[0].code, "secret-reveal-description");
});

test("metadata leakage harness rejects too many required metadata surfaces", () => {
  const harness = createMetadataLeakageHarness({
    allowedSurfaces: ["rpc", "indexer", "prover"],
    requireKnownMitigation: true,
    maxRequiredSurfaces: 2
  });

  const review = harness.reviewBudget({
    ...baseBudget,
    items: [
      baseBudget.items[0],
      {
        surface: "indexer",
        reveals: "private note sync window",
        required: true,
        mitigation: "incremental local checkpoints"
      },
      {
        surface: "prover",
        reveals: "proof job timing",
        required: true,
        mitigation: "local prover when available"
      }
    ]
  });

  assert.equal(review.approved, false);
  assert.equal(review.violations.at(-1).code, "too-many-required-surfaces");
});

test("metadata assertion uses the leakage harness", () => {
  assert.throws(
    () =>
      assertMetadataBudgetAllowed(
        {
          ...baseBudget,
          items: [
            {
              surface: "prover",
              reveals: "proof job timing",
              required: true
            }
          ]
        },
        {
          allowedSurfaces: ["prover"],
          requireKnownMitigation: true
        }
      ),
    MetadataBudgetExceededError
  );
});
