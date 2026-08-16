import assert from "node:assert/strict";
import test from "node:test";
import { assessRecipient } from "../src/features/wallet/recipientRisk.ts";
import { NATIVE_SEND_GAS_CEILING, nativeMaxAmount, nativeSendReserve } from "../src/features/wallet/sendLimits.ts";

const account = "0xcccccccccccccccccccccccccccccccccccccccc";
const token = "0xdddddddddddddddddddddddddddddddddddddddd";
const stranger = "0x1234567890abcdef1234567890abcdef12345678";

// --- gas-aware Max ---------------------------------------------------------

test("Max keeps back enough for the account to pay for its own operation", () => {
  const balance = 10n ** 18n;
  const maxFeePerGas = 2_000_000_000n;
  const reserve = nativeSendReserve({ maxFeePerGas });
  assert.equal(reserve, maxFeePerGas * NATIVE_SEND_GAS_CEILING);
  assert.equal(nativeMaxAmount({ balance, maxFeePerGas }), balance - reserve);
});

test("Max is nothing when the balance cannot even cover the reserve", () => {
  // Offering to send a balance that cannot pay for its own transfer produces a
  // guaranteed failure, so there is nothing to offer.
  assert.equal(nativeMaxAmount({ balance: 1n, maxFeePerGas: 2_000_000_000n }), 0n);
  assert.equal(nativeMaxAmount({ balance: 0n, maxFeePerGas: 2_000_000_000n }), 0n);
});

test("Max never returns the whole balance for the native token", () => {
  const balance = 5n * 10n ** 18n;
  const amount = nativeMaxAmount({ balance, maxFeePerGas: 1_000_000_000n });
  assert.ok(amount < balance, "the full balance would leave nothing to pay gas with");
  assert.ok(amount > 0n);
});

test("a fee price of zero still reserves nothing rather than throwing", () => {
  const balance = 10n ** 18n;
  assert.equal(nativeMaxAmount({ balance, maxFeePerGas: 0n }), balance);
});

// --- recipient risk --------------------------------------------------------

test("sending to the account itself is flagged", () => {
  const risks = assessRecipient({ recipient: account, account, known: [] });
  assert.ok(risks.some(risk => risk.kind === "self"));
});

test("sending to the zero address is flagged", () => {
  const risks = assessRecipient({ recipient: `0x${"00".repeat(20)}`, account, known: [] });
  assert.ok(risks.some(risk => risk.kind === "burn"));
});

test("sending a token to its own contract is flagged", () => {
  const risks = assessRecipient({ recipient: token, account, known: [{ address: token, label: "USDC", kind: "contract" }] });
  assert.ok(risks.some(risk => risk.kind === "contract"));
});

test("an address that mimics a known one at both ends is flagged as a look-alike", () => {
  // Address poisoning: the attacker's address shares the prefix and suffix a
  // person actually compares, and differs in the middle nobody reads.
  const real = "0xabcdef0000000000000000000000000000abcdef";
  const lookAlike = "0xabcdef1111111111111111111111111111abcdef";
  const risks = assessRecipient({ recipient: lookAlike, account, known: [{ address: real, label: "Savings", kind: "known" }] });
  const found = risks.find(risk => risk.kind === "look-alike");
  assert.ok(found, "a near-identical address must be flagged");
  assert.equal(found.similarTo.toLowerCase(), real.toLowerCase());
  assert.equal(found.label, "Savings");
});

test("the exact known address is not flagged as a look-alike of itself", () => {
  const real = "0xabcdef0000000000000000000000000000abcdef";
  const risks = assessRecipient({ recipient: real, account, known: [{ address: real, label: "Savings", kind: "known" }] });
  assert.ok(!risks.some(risk => risk.kind === "look-alike"));
});

test("an unrelated address raises nothing", () => {
  const real = "0xabcdef0000000000000000000000000000abcdef";
  const risks = assessRecipient({ recipient: stranger, account, known: [{ address: real, label: "Savings", kind: "known" }] });
  assert.deepEqual(risks, []);
});

test("a shared prefix alone is not enough to cry wolf", () => {
  // Only one end matching is common enough that warning on it would train people
  // to dismiss the warning that matters.
  const real = "0xabcdef0000000000000000000000000000abcdef";
  const sharedPrefixOnly = "0xabcdef1111111111111111111111111111111111";
  const risks = assessRecipient({ recipient: sharedPrefixOnly, account, known: [{ address: real, label: "Savings", kind: "known" }] });
  assert.ok(!risks.some(risk => risk.kind === "look-alike"));
});

test("risk assessment is case-insensitive about checksums", () => {
  const risks = assessRecipient({ recipient: account.toUpperCase().replace("0X", "0x"), account, known: [] });
  assert.ok(risks.some(risk => risk.kind === "self"));
});
