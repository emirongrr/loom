import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { prepareDeploymentManifest } from "./build-deployment-manifest.mjs";
import { deploymentAttestationMessage } from "./validate-deployment-manifest.mjs";

const ROLES = ["deployer", "independent-reproducer", "security-reviewer"];

export async function prepareDeploymentAttestations(config, options = {}) {
  const draft = await prepareDeploymentManifest(config, options);
  const requests = config.attestations;
  if (!Array.isArray(requests) || requests.length !== ROLES.length) {
    throw new Error("config.attestations must contain exactly three attestation requests");
  }

  const byRole = new Map(requests.map(request => [request.role, request]));
  const attestations = ROLES.map(role => {
    const request = byRole.get(role);
    if (!request) throw new Error(`missing attestation request role: ${role}`);
    const signer = getAddress(request.signer);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(request.signedAt ?? "")) {
      throw new Error(`${role}.signedAt must use YYYY-MM-DD`);
    }
    if (typeof request.statement !== "string" || request.statement.length < 20) {
      throw new Error(`${role}.statement is required`);
    }
    return Object.freeze({
      role,
      signer,
      signedAt: request.signedAt,
      statement: request.statement,
      manifestHash: draft.evidenceDigest,
      message: deploymentAttestationMessage({
        role,
        chainId: draft.network.chainId,
        manifestHash: draft.evidenceDigest,
        signedAt: request.signedAt,
        statement: request.statement
      })
    });
  });

  if (new Set(attestations.map(item => item.signer)).size !== attestations.length) {
    throw new Error("attestation signers must be distinct");
  }
  const deployers = new Set(draft.deployments.map(item => getAddress(item.receipt.deployer)));
  if (deployers.size !== 1 || !deployers.has(attestations[0].signer)) {
    throw new Error("deployer attestation signer must match every deployment receipt deployer");
  }

  return Object.freeze({
    version: 1,
    chainId: draft.network.chainId,
    evidenceDigest: draft.evidenceDigest,
    attestations: Object.freeze(attestations)
  });
}

async function main() {
  const [configPath, outputPath] = process.argv.slice(2);
  if (!configPath) {
    throw new Error("usage: node tools/evidence/prepare-deployment-attestations.mjs <config.json> [output.json]");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const payload = await prepareDeploymentAttestations(config);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, text);
  else process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
