import assert from "node:assert/strict";
import test from "node:test";
import { describeWalletRecovery, readWalletsBeingRecovered } from "../src/features/wallet/walletsBeingRecovered.ts";

const NOW = 1_900_000_000;
const wallet = (id: string, byte: string, chainId = 11_155_111) =>
  ({ id, account: `0x${byte.repeat(20)}` as const, chainId });

const none = { pending: false, readyAt: 0n, expiresAt: 0n };
const waiting = { pending: true, readyAt: BigInt(NOW + 86_400), expiresAt: BigInt(NOW + 700_000) };
const matured = { pending: true, readyAt: BigInt(NOW - 60), expiresAt: BigInt(NOW + 600_000) };

test("a wallet with nothing pending is marked with nothing", async () => {
  const flags = await readWalletsBeingRecovered({
    accounts: [wallet("a", "11")], chainId: 11_155_111, nowSeconds: NOW, readPending: async () => none
  });
  assert.equal(flags.get("a")?.kind, "none");
  assert.equal(describeWalletRecovery(flags.get("a")), null);
});

// The delay is the whole point: it exists so the owner has time to object, and
// they cannot object to something their own list never mentions.
test("a recovery inside its delay is announced on the wallet, not only inside it", async () => {
  const flags = await readWalletsBeingRecovered({
    accounts: [wallet("a", "11")], chainId: 11_155_111, nowSeconds: NOW, readPending: async () => waiting
  });
  assert.equal(flags.get("a")?.kind, "waiting");
  const described = describeWalletRecovery(flags.get("a"))!;
  assert.equal(described.urgent, true);
  assert.match(described.detail, /time to stop it/u);
});

test("a matured recovery says it can be completed by anyone at any moment", async () => {
  const flags = await readWalletsBeingRecovered({
    accounts: [wallet("a", "11")], chainId: 11_155_111, nowSeconds: NOW, readPending: async () => matured
  });
  assert.equal(flags.get("a")?.kind, "executable");
  assert.match(describeWalletRecovery(flags.get("a"))!.detail, /anyone at any moment/u);
});

// One unreachable account must not decide what is shown about the others, and
// must not be reported as having nothing pending.
test("an account that cannot be read is marked unknown and does not silence the rest", async () => {
  const flags = await readWalletsBeingRecovered({
    accounts: [wallet("a", "11"), wallet("b", "22")],
    chainId: 11_155_111,
    nowSeconds: NOW,
    readPending: async account => {
      if (account.startsWith("0x1111")) throw new Error("rpc unreachable");
      return waiting;
    }
  });
  assert.equal(flags.get("a")?.kind, "unreadable");
  assert.equal(flags.get("b")?.kind, "waiting");
  assert.equal(describeWalletRecovery(flags.get("a"))!.label, "Not checked");
});

test("wallets on another chain are not asked about", async () => {
  let asked = 0;
  const flags = await readWalletsBeingRecovered({
    accounts: [wallet("a", "11"), wallet("b", "22", 1)],
    chainId: 11_155_111,
    nowSeconds: NOW,
    readPending: async () => { asked += 1; return none; }
  });
  assert.equal(asked, 1);
  assert.equal(flags.has("b"), false);
});
