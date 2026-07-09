import bundledManifest from "../../../deployment/sepolia.manifest.json";

import { blockedGate } from "../../platform/errors";
import type { MobileWalletConfiguration, ReleaseGate } from "../../types/wallet";
import { parseDeploymentManifest, verifyDeploymentAgainstManifest } from "./manifest";

// Runtime deployment verification.
//
// scripts/connect-deployment.mjs writes deployment/sepolia.manifest.json from
// the forge broadcast and cross-checks it against the chain. This module is
// the app-side half of that contract: at runtime the configured addresses
// must match the bundled manifest, or the wallet reports itself as not
// connected to a Loom deployment. A placeholder manifest (fresh checkout)
// parses as invalid and produces a single explicit gate instead of a crash.
export function deploymentManifestGates(config: MobileWalletConfiguration): readonly ReleaseGate[] {
  if (!config.deployment.accountFactory && !config.deployment.passkeyValidator) {
    // Nothing configured yet — configurationReadiness already reports every
    // missing value; a manifest mismatch on top would be noise.
    return [];
  }

  try {
    const manifest = parseDeploymentManifest(bundledManifest);
    return verifyDeploymentAgainstManifest(config, manifest);
  } catch (error) {
    return [
      blockedGate({
        id: "deployment.manifest.not-generated",
        title: "Deployment manifest not generated",
        summary:
          error instanceof Error && "status" in (bundledManifest as Record<string, unknown>)
            ? "deployment/sepolia.manifest.json is still the placeholder. Deploy Loom (script/DeploySepolia.s.sol) and run `npm run deploy:connect` so the app can verify its addresses."
            : `Bundled deployment manifest is invalid: ${error instanceof Error ? error.message : String(error)}`
      })
    ];
  }
}
