import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertWalletLabArtifact, nativeTransferScenario } from "./dist/index.js";
import { assertReplayEquivalent } from "./replay-compare.mjs";

const input = process.argv[2];
if (!input) throw new Error("usage: npm run wallet-lab:replay -- <run-artifact.json>");
const sourcePath = resolve(input);
if (!existsSync(sourcePath)) throw new Error(`wallet lab artifact not found: ${sourcePath}`);
const source = JSON.parse(readFileSync(sourcePath, "utf8"));
assertWalletLabArtifact(source);
if (source.scenarioId !== nativeTransferScenario.id || source.replay.scenarioVersion !== nativeTransferScenario.version) {
  throw new Error(`unsupported wallet lab replay scenario: ${source.scenarioId}@${source.replay.scenarioVersion}`);
}
if (source.replay.seed !== nativeTransferScenario.seed) throw new Error("wallet lab replay seed does not match the scenario");

const outputPath = sourcePath.replace(/\.json$/i, ".replay.json");
const runId = `replay-${crypto.randomBytes(8).toString("hex")}`;
process.env.LOOM_WALLET_LAB_ARTIFACT = outputPath;
process.env.LOOM_WALLET_LAB_RUN_ID = runId;
process.env.LOOM_WALLET_LAB_TRACE_ID = crypto.createHash("sha256").update(`${runId}:${source.scenarioId}`).digest("hex").slice(0, 32);
process.env.LOOM_WALLET_LAB_GIT_COMMIT = source.environment?.gitCommit ?? "unknown";
process.env.LOOM_WALLET_LAB_GIT_DIRTY = "false";
process.env.LOOM_WALLET_LAB_BROWSER_FLOW = String(source.events.some(event => event.component === "wallet-ui" && event.phase === "ui"));

console.log(`Replaying ${source.scenarioId} from a clean pinned devnet with seed ${source.replay.seed}`);
await import("../../tools/e2e/bundler-devnet.mjs");
const replay = JSON.parse(readFileSync(outputPath, "utf8"));
assertWalletLabArtifact(replay);
assertReplayEquivalent(source, replay);
console.log("Replay equivalence: account, UserOperation hash, semantic state, and invariants match.");
console.log(`Replay artifact: ${outputPath}`);
