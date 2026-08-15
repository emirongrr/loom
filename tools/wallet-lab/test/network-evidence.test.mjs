import assert from "node:assert/strict";
import test from "node:test";
import { annotateNetworkExchange } from "../network-evidence.mjs";

test("network evidence binds each RPC call to an operation and plain-language purpose", () => {
  const estimate = annotateNetworkExchange({ transport: "bundler", request: { method: "eth_estimateUserOperationGas" } }, "native-transfer");
  assert.deepEqual({ operation: estimate.operation, stage: estimate.stage, requirement: estimate.requirement }, {
    operation: "native-transfer",
    stage: "simulation",
    requirement: "required-for-observed-flow"
  });
  assert.match(estimate.explanation, /gas|simulation/i);

  const balance = annotateNetworkExchange({ transport: "rpc", request: { method: "eth_getBalance" } }, "post-operation-verification");
  assert.equal(balance.stage, "state-verification");
  assert.equal(balance.requirement, "independent-check");

  const pimlicoFees = annotateNetworkExchange({ transport: "bundler", request: { method: "pimlico_getUserOperationGasPrice" } }, "account-activation");
  assert.equal(pimlicoFees.stage, "fee-preparation");
  assert.equal(pimlicoFees.requirement, "provider-specific");
  assert.match(pimlicoFees.explanation, /Pimlico|provider/i);
});

test("unknown methods remain visible without being described as protocol requirements", () => {
  const exchange = annotateNetworkExchange({ transport: "rpc", request: { method: "debug_customMethod" } }, "wallet-discovery");
  assert.equal(exchange.stage, "other");
  assert.equal(exchange.requirement, "observed-only");
  assert.match(exchange.explanation, /captured/i);
});
