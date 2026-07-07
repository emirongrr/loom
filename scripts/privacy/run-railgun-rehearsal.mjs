import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runRailgunLiveRehearsal } from "../../packages/privacy/src/index.js";
import { validatePrivacyAdapterProfile } from "../../tools/evidence/validate-privacy-adapter-profile.mjs";

const usage = [
  "usage: LOOM_PRIVACY_REHEARSAL=1 node scripts/privacy/run-railgun-rehearsal.mjs <config.json> <evidence.json>",
  "",
  "The config must not contain viewing keys, private keys, seed phrases, guardian salts, or account graphs.",
  "Use user-selected RPC/indexer/relayer/prover endpoints and record only hashed operation/checkpoint evidence."
].join("\n");

export async function buildRailgunRehearsalEvidence(config) {
  rejectSecrets(config);
  const evidence = await runRailgunLiveRehearsal({
    ...config,
    confirmLiveNetwork: true,
    providerConsentConfirmed: true
  });
  validatePrivacyAdapterProfile(evidence);
  return evidence;
}

export function rejectSecrets(value, path = "config") {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (/(private key|viewing key|scanning key|seed phrase|guardian salt|account graph)/i.test(value)) {
      throw new Error(`${path} appears to contain secret material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(privateKey|viewingKey|scanningKey|seedPhrase|guardianSalt|mnemonic)$/i.test(key)) {
        throw new Error(`${path}.${key} must not be present in rehearsal config`);
      }
      rejectSecrets(item, `${path}.${key}`);
    }
  }
}

async function main() {
  const [configPath, outputPath] = process.argv.slice(2);

  if (!configPath || !outputPath) {
    throw new Error(usage);
  }

  if (process.env.LOOM_PRIVACY_REHEARSAL !== "1") {
    throw new Error("set LOOM_PRIVACY_REHEARSAL=1 to acknowledge live privacy rehearsal side effects");
  }

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const evidence = await buildRailgunRehearsalEvidence(config);

  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`wrote Railgun privacy rehearsal evidence to ${outputPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
