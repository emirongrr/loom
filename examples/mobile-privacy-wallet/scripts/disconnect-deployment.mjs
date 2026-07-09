// Disconnects the app from its Loom deployment.
//
//   npm run deployment:remove
//
// The contracts themselves are immutable and stay on chain — there is nothing
// to "delete" there, and no admin key that could. What this removes is the
// app-side connection:
//
//   1. The current manifest is archived to deployment/archive/ (local only),
//      so the same deployment can be reconnected later without redeploying.
//   2. deployment/sepolia.manifest.json is reset to the not-deployed
//      placeholder.
//   3. Every EXPO_PUBLIC_LOOM_* deployment field in .env.local is emptied.
//
// After this, preflight blocks `npm run start` again and the home screen
// shows the "Not connected to a Loom deployment" state.
//
// Reconnect options:
//   - fresh deployment:            npm run bootstrap
//   - reuse the archived one:      npm run deploy:connect -- --rpc <url>
//     (the forge broadcast under <repo>/broadcast/ is still the source)

import fs from "node:fs";
import path from "node:path";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(exampleRoot, "deployment", "sepolia.manifest.json");
const archiveDir = path.join(exampleRoot, "deployment", "archive");
const envPath = path.join(exampleRoot, ".env.local");

const PLACEHOLDER = {
  status: "not-deployed",
  notes:
    "Placeholder. Run the Sepolia deployment (script/DeploySepolia.s.sol) and then `npm run deploy:connect` " +
    "to generate the real manifest; the app refuses to treat itself as connected until this file carries " +
    "verified addresses."
};

const DEPLOYMENT_KEYS = [
  "EXPO_PUBLIC_LOOM_CHAIN_ID",
  "EXPO_PUBLIC_LOOM_L1_CHAIN_ID",
  "EXPO_PUBLIC_LOOM_ENTRYPOINT",
  "EXPO_PUBLIC_LOOM_ACCOUNT_FACTORY",
  "EXPO_PUBLIC_LOOM_PASSKEY_VALIDATOR",
  "EXPO_PUBLIC_LOOM_P256_VERIFIER_MODE",
  "EXPO_PUBLIC_LOOM_P256_VERIFIER",
  "EXPO_PUBLIC_LOOM_DEPLOYMENT_MANIFEST"
];

// --- 1. Archive the manifest if it carries a real deployment ------------------

let hadDeployment = false;
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  hadDeployment = Number.isInteger(manifest.chainId) && manifest.chainId > 0;
  if (hadDeployment) {
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = path.join(archiveDir, `sepolia.manifest.${stamp}.json`);
    fs.copyFileSync(manifestPath, archivePath);
    console.log(`Archived current manifest -> ${path.relative(exampleRoot, archivePath)}`);
  }
} catch {
  // Unreadable or placeholder manifest: nothing to archive.
}

// --- 2. Reset manifest ---------------------------------------------------------

fs.writeFileSync(manifestPath, `${JSON.stringify(PLACEHOLDER, null, 2)}\n`);
console.log("Reset deployment/sepolia.manifest.json to the not-deployed placeholder.");

// --- 3. Empty the deployment fields in .env.local -------------------------------

let clearedKeys = 0;
if (fs.existsSync(envPath)) {
  let env = fs.readFileSync(envPath, "utf8");
  for (const key of DEPLOYMENT_KEYS) {
    const pattern = new RegExp(`^${key}=.+$`, "m");
    if (pattern.test(env)) {
      env = env.replace(pattern, `${key}=`);
      clearedKeys += 1;
    }
  }
  fs.writeFileSync(envPath, env);
}
console.log(`Cleared ${clearedKeys} deployment field(s) in .env.local.`);

// --- 4. Report -------------------------------------------------------------------

console.log(`
${hadDeployment ? "Deployment disconnected." : "No connected deployment was found; app-side state reset anyway."}
The on-chain contracts are immutable and remain deployed; only the app-side
connection was removed. Preflight will now block \`npm run start\`.

Reconnect later with:
  npm run bootstrap                      # fresh deployment
  npm run deploy:connect -- --rpc <url>  # reuse the previous broadcast/archive
`);
