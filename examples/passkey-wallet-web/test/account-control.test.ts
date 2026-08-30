import assert from "node:assert/strict";
import test from "node:test";
import { describeAccountControl, readAccountControl } from "../src/features/wallet/accountControl.ts";

const ACCOUNT = "0x8A2f1487c2B30c371c0Cd2862d3B5FD05981aFc1" as const;
const OLD = "0xfce4aae992886239100cb45f59d348aaf4ac5eb4" as const;
const NEW = "0x8A2eB4eC44C00A479cAefFFf988D2D511705c583" as const;

const chain = (installed: readonly string[]) => async (input: { module: string }) =>
  installed.some(address => address.toLowerCase() === input.module.toLowerCase());

test("a validator still installed means this device can sign", async () => {
  const control = await readAccountControl({
    account: ACCOUNT, validator: OLD, deployed: true, isModuleInstalled: chain([OLD])
  });
  assert.equal(control.kind, "in-control");
  assert.equal(describeAccountControl(control), null);
});

// The exact shape of the report: after a completed recovery the account holds a
// different validator, and the old key signs against something that is gone.
// The bundler calls this AA24, which names neither the recovery nor the key.
test("a replaced validator is reported as a recovered account, not as a signing error", async () => {
  const control = await readAccountControl({
    account: ACCOUNT, validator: OLD, deployed: true, isModuleInstalled: chain([NEW])
  });
  assert.equal(control.kind, "superseded");
  const described = describeAccountControl(control);
  assert.match(described!.title, /has been recovered/u);
  assert.match(described!.detail, /no longer controls it/u);
  // Recovery is not loss, and saying so is the difference between a person
  // finding their key and a person believing their funds are gone.
  assert.match(described!.detail, /not lost/u);
});

// An account that does not exist yet installs this device's validator with its
// first operation, so it is not superseded -- it has simply not started.
test("an account with no code yet is not reported as recovered", async () => {
  const control = await readAccountControl({
    account: ACCOUNT, validator: OLD, deployed: false,
    isModuleInstalled: async () => { throw new Error("must not be asked"); }
  });
  assert.equal(control.kind, "in-control");
});

test("an account that cannot be read is reported as unknown, never as in control", async () => {
  const control = await readAccountControl({
    account: ACCOUNT, validator: OLD, deployed: true,
    isModuleInstalled: async () => { throw new Error("rpc unreachable"); }
  });
  assert.equal(control.kind, "unreadable");
  assert.match(describeAccountControl(control)!.detail, /unknown until the account can be read/u);
});
