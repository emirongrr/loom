import Ajv from "ajv";
import { keccak256, toBytes } from "viem";
import { LoomError } from "./errors.js";
import type { Address, Hex } from "./hex.js";

/**
 * The one canonical Loom deployment manifest. It is the single source of
 * deployed addresses and the code hashes that make those addresses trustworthy.
 * Application-facing records are projections of it (see
 * {@link createDeploymentProfile}), never a second schema.
 */
export interface LoomDeploymentManifest {
  schemaVersion: "1";
  releaseChannel: "devnet" | "testnet" | "mainnet";
  chainId: number;
  entryPoint: DeployedContract;
  factory: DeployedContract;
  account: {
    implementation: DeployedContract;
    proxy: { creationCodeHash: Hex; runtimeCodeHash: Hex };
  };
  modules: ManifestModule[];
  compatibility: { contractRelease: string; sdkRange: string };
}

export interface DeployedContract {
  address: Address;
  runtimeCodeHash: Hex;
}

export interface ManifestModule {
  type: "validator" | "hook" | "recovery";
  address: Address;
  runtimeCodeHash: Hex;
  version: string;
  status: "stable" | "beta" | "experimental";
}

/** An application-facing projection, cryptographically bound to its source manifest. */
export interface DeploymentProfile {
  sourceManifestHash: Hex;
  chainId: number;
  entryPoint: Address;
  accountImplementation: Address;
  factory: Address;
  modules: ReadonlyArray<Pick<ManifestModule, "type" | "address" | "version" | "status">>;
}

const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } as const;
const BYTES32 = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } as const;

/**
 * The published JSON Schema for {@link LoomDeploymentManifest}. This object is
 * the single source of truth; `schemas/deployment-manifest/v1.schema.json` is
 * generated from it and kept honest by a freshness test.
 */
export const DEPLOYMENT_MANIFEST_SCHEMA_V1 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://loom.dev/schemas/deployment-manifest/v1.schema.json",
  title: "LoomDeploymentManifest",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "releaseChannel", "chainId", "entryPoint", "factory", "account", "modules", "compatibility"],
  properties: {
    schemaVersion: { const: "1" },
    releaseChannel: { enum: ["devnet", "testnet", "mainnet"] },
    chainId: { type: "integer", minimum: 1 },
    entryPoint: { $ref: "#/definitions/deployedContract" },
    factory: { $ref: "#/definitions/deployedContract" },
    account: {
      type: "object",
      additionalProperties: false,
      required: ["implementation", "proxy"],
      properties: {
        implementation: { $ref: "#/definitions/deployedContract" },
        proxy: {
          type: "object",
          additionalProperties: false,
          required: ["creationCodeHash", "runtimeCodeHash"],
          properties: { creationCodeHash: BYTES32, runtimeCodeHash: BYTES32 }
        }
      }
    },
    modules: { type: "array", items: { $ref: "#/definitions/module" } },
    compatibility: {
      type: "object",
      additionalProperties: false,
      required: ["contractRelease", "sdkRange"],
      properties: { contractRelease: { type: "string", minLength: 1 }, sdkRange: { type: "string", minLength: 1 } }
    }
  },
  definitions: {
    deployedContract: {
      type: "object",
      additionalProperties: false,
      required: ["address", "runtimeCodeHash"],
      properties: { address: ADDRESS, runtimeCodeHash: BYTES32 }
    },
    module: {
      type: "object",
      additionalProperties: false,
      required: ["type", "address", "runtimeCodeHash", "version", "status"],
      properties: {
        type: { enum: ["validator", "hook", "recovery"] },
        address: ADDRESS,
        runtimeCodeHash: BYTES32,
        version: { type: "string", minLength: 1 },
        status: { enum: ["stable", "beta", "experimental"] }
      }
    }
  }
} as const;

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(DEPLOYMENT_MANIFEST_SCHEMA_V1);

/**
 * Validate an untrusted value against the canonical schema and return it typed.
 * Unknown fields are rejected. Throws a {@link LoomError} with code
 * `MANIFEST_INVALID` describing the first failures.
 */
export function parseDeploymentManifest(input: unknown): LoomDeploymentManifest {
  if (!validate(input)) {
    const detail = (validate.errors ?? [])
      .map(error => `${error.instancePath || "/"} ${error.message ?? ""}`.trim())
      .join("; ");
    throw new LoomError("MANIFEST_INVALID", `invalid deployment manifest: ${detail}`, {
      safeMessage: "invalid deployment manifest",
      details: { errors: validate.errors ?? [] }
    });
  }
  return input as LoomDeploymentManifest;
}

/**
 * Deterministic hash of a manifest: keccak256 over its canonical (key-sorted)
 * JSON serialization. Projections carry this as `sourceManifestHash`.
 */
export function manifestHash(manifest: LoomDeploymentManifest): Hex {
  return keccak256(toBytes(canonicalize(manifest)));
}

/**
 * Derive an application profile from a manifest, bound to its source hash. When
 * `selection.modules` is given, only those module addresses are carried.
 */
export function createDeploymentProfile(
  manifest: LoomDeploymentManifest,
  selection: { modules?: ReadonlyArray<Address> } = {}
): DeploymentProfile {
  const wanted = selection.modules;
  const modules = manifest.modules
    .filter(module => wanted === undefined || wanted.includes(module.address))
    .map(module => ({ type: module.type, address: module.address, version: module.version, status: module.status }));

  return Object.freeze({
    sourceManifestHash: manifestHash(manifest),
    chainId: manifest.chainId,
    entryPoint: manifest.entryPoint.address,
    accountImplementation: manifest.account.implementation.address,
    factory: manifest.factory.address,
    modules: Object.freeze(modules)
  });
}

/** Stable, key-sorted JSON serialization used for hashing. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
