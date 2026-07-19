import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor, redactUrl } from "../src/doctor.mjs";

// The doctor is drivable entirely with injected fake transports, so its report
// logic is unit-tested here without a chain; a live run against `loom devnet`
// is the end-to-end proof (tools/e2e/bundler-devnet.mjs).

const bin = fileURLToPath(new URL("../bin/loom.mjs", import.meta.url));
const entryPoint = "0x433709e09c7750b04c222fb46e0f27642f41f0b7";
const senderCreator = "0x1234567890123456789012345678901234567890";

// A fake execution RPC: chain id, EntryPoint.senderCreator(), code presence,
// and the P-256 precompile (valid vector -> 1, corrupted -> 0x).
function fakeRpc({ chainId = 31337, codeAt = new Set([entryPoint, senderCreator]), p256 = true } = {}) {
  const calls = [];
  // probeP256Precompile calls the precompile twice: first the pristine input
  // (must verify -> 1), then a corrupted copy (must reject -> 0x). A monotonic
  // counter distinguishes them without depending on the random input.
  let precompileCalls = 0;
  return {
    calls,
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (method === "eth_call") {
        const to = params[0].to.toLowerCase();
        const data = params[0].data ?? "";
        if (data.startsWith("0x09ccb880")) return `0x${"0".repeat(24)}${senderCreator.slice(2)}`;
        if (to === "0x0000000000000000000000000000000000000100") {
          precompileCalls += 1;
          if (!p256) return "0x";
          return precompileCalls === 1 ? `0x${"0".repeat(63)}1` : "0x";
        }
        return "0x";
      }
      if (method === "eth_getCode") {
        return codeAt.has(params[0].toLowerCase()) || codeAt.has(params[0]) ? "0x60fe" : "0x";
      }
      return null;
    }
  };
}

test("redactUrl keeps only the origin, dropping credentials and query", () => {
  assert.equal(redactUrl("https://user:secret@rpc.example.com:8545/path?key=abc"), "https://rpc.example.com:8545");
  assert.equal(redactUrl("http://127.0.0.1:8545"), "http://127.0.0.1:8545");
  assert.equal(redactUrl(undefined), null);
  assert.equal(redactUrl("not a url"), "<redacted>");
});

test("a healthy chain with no manifest passes the reachable checks and skips the rest", async () => {
  const { rpc } = fakeRpc();
  const report = await runDoctor({ rpc, entryPoint, chainId: 31337 });
  assert.equal(report.ok, true);
  const byName = Object.fromEntries(report.checks.map(c => [c.name, c]));
  assert.equal(byName.chain.status, "ok");
  assert.equal(byName.entryPoint.status, "ok");
  assert.equal(byName.senderCreator.status, "ok");
  assert.equal(byName.p256.status, "ok");
  assert.equal(byName.bundler.status, "skip");
  assert.equal(byName.account.status, "skip");
  assert.equal(byName.privacy.status, "skip");
});

test("a chain-id mismatch fails", async () => {
  const { rpc } = fakeRpc({ chainId: 1 });
  const report = await runDoctor({ rpc, entryPoint, chainId: 31337 });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.name === "chain").status, "fail");
});

test("a SenderCreator with no code fails", async () => {
  const { rpc } = fakeRpc({ codeAt: new Set([entryPoint]) });
  const report = await runDoctor({ rpc, entryPoint, chainId: 31337 });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.name === "senderCreator").status, "fail");
});

test("an absent native P-256 precompile warns but does not fail", async () => {
  const { rpc } = fakeRpc({ p256: false });
  const report = await runDoctor({ rpc, entryPoint, chainId: 31337 });
  assert.equal(report.checks.find(c => c.name === "p256").status, "warn");
  assert.equal(report.ok, true);
});

test("the bundler check fails when the expected EntryPoint is not served", async () => {
  const { rpc } = fakeRpc();
  const report = await runDoctor({
    rpc,
    entryPoint,
    chainId: 31337,
    bundlerRpc: async () => ["0x0000000000000000000000000000000000000099"]
  });
  assert.equal(report.checks.find(c => c.name === "bundler").status, "fail");
  assert.equal(report.ok, false);
});

test("the bundler check passes when the EntryPoint is served", async () => {
  const { rpc } = fakeRpc();
  const report = await runDoctor({
    rpc,
    entryPoint,
    chainId: 31337,
    bundlerRpc: async () => [entryPoint]
  });
  assert.equal(report.checks.find(c => c.name === "bundler").status, "ok");
});

test("a manifest code-hash mismatch fails through the delegated verifier", async () => {
  // The manifest claims a hash the on-chain code will not match (fake returns
  // fixed bytecode), so verifyManifestOnChain reports a failure.
  const { rpc } = fakeRpc();
  const manifest = {
    schemaVersion: 1,
    chainId: 31337,
    entryPoint: { address: entryPoint, runtimeCodeHash: `0x${"11".repeat(32)}` },
    factory: { address: "0x2222222222222222222222222222222222222222", runtimeCodeHash: `0x${"22".repeat(32)}` },
    account: { implementation: { address: "0x3333333333333333333333333333333333333333", runtimeCodeHash: `0x${"33".repeat(32)}` } },
    modules: []
  };
  const report = await runDoctor({ rpc, manifest, chainId: 31337 });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.name === "manifest").status, "fail");
});

test("the doctor CLI exits 6 on a verification failure and redacts endpoints in --json", () => {
  // Drive the real bin against an unreachable RPC: chain check fails -> exit 6,
  // and the JSON envelope must carry only the redacted origin.
  const result = spawnSync(
    process.execPath,
    [bin, "doctor", "--rpc-url", "http://user:secret@127.0.0.1:59321/rpc?token=abc", "--chain-id", "31337", "--json"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 6);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.endpoints.rpc, "http://127.0.0.1:59321");
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  assert.equal(JSON.stringify(parsed).includes("token=abc"), false);
});

test("the doctor CLI requires --rpc-url", () => {
  const result = spawnSync(process.execPath, [bin, "doctor"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --rpc-url/);
});


test("the monitor CLI requires --rpc-url and --manifest", () => {
  const missing = spawnSync(process.execPath, [bin, "monitor", "--rpc-url", "http://127.0.0.1:8545"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /requires --rpc-url and --manifest/);
});
