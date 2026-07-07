import { readFile, writeFile } from "node:fs/promises";
import {
  buildGuardianOnboardingEvidence,
  validateGuardianOnboardingEvidence
} from "../../packages/guardian/src/index.js";

const usage = [
  "usage: node tools/evidence/build-guardian-onboarding-evidence.mjs <ceremony-input.json> <public-evidence.json>",
  "",
  "The input is local and sensitive because it contains guardian salts and commitments.",
  "The output is redacted public evidence and must still be reviewed before publication."
].join("\n");

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  throw new Error(usage);
}

const input = JSON.parse(await readFile(inputPath, "utf8"));
rejectPrivateSigningMaterial(input);

const evidence = buildGuardianOnboardingEvidence(input);
validateGuardianOnboardingEvidence(evidence);

await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote redacted guardian onboarding evidence to ${outputPath}`);

function rejectPrivateSigningMaterial(value, path = "input") {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (/(private key|seed phrase|mnemonic|recovery phrase|viewing key|scanning key)/i.test(value)) {
      throw new Error(`${path} appears to contain private signing or viewing material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivateSigningMaterial(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/(privateKey|seedPhrase|mnemonic|recoveryPhrase|viewingKey|scanningKey)/i.test(key)) {
        throw new Error(`${path}.${key} must not be present in ceremony input`);
      }
      rejectPrivateSigningMaterial(item, `${path}.${key}`);
    }
  }
}
