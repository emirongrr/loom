import assert from "node:assert/strict";
import test from "node:test";

import type { MetadataBudget, PrivacyContext, RailgunAdapterProfile } from "@loom/privacy";
import type { LoomClient } from "@loom/sdk";

import { configurationReadiness, readEnvironmentConfiguration } from "../src/config/environment";
import { preparePasskeyAccountCreation } from "../src/flows/createAccountFlow";
import { preparePrivateSend } from "../src/flows/privacySendFlow";
import { prepareSessionGrant } from "../src/flows/sessionFlow";
import type {
  Hex,
  MobileWalletConfiguration,
  PlatformPasskeyAuthenticator,
  SessionPermissionDraft
} from "../src/types/wallet";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Hex;
const FACTORY = "0x2222222222222222222222222222222222222222" as Hex;
const VALIDATOR = "0x3333333333333333333333333333333333333333" as Hex;
const ENTRY_POINT = "0x4444444444444444444444444444444444444444" as Hex;
const SESSION_KEY = "0x5555555555555555555555555555555555555555" as Hex;
const TARGET = "0x6666666666666666666666666666666666666666" as Hex;
const TOKEN = "0x0000000000000000000000000000000000000000" as Hex;
const SELECTOR = "0xa9059cbb" as Hex;
const CHALLENGE = ("0x" + "ab".repeat(32)) as Hex;
const CREDENTIAL_ID_HASH = ("0x" + "cd".repeat(32)) as Hex;

function completeConfiguration(): MobileWalletConfiguration {
  return {
    rpId: "wallet.example.org",
    origin: "https://wallet.example.org",
    network: {
      chainId: 11155111,
      l1ChainId: 11155111,
      bundlerUrl: "https://bundler.example.org",
      entryPoint: ENTRY_POINT
    },
    verifiedState: {
      mode: "helios",
      helios: { networkKind: "ethereum", network: "sepolia" }
    },
    deployment: {
      accountFactory: FACTORY,
      passkeyValidator: VALIDATOR,
      p256VerifierMode: "native-precompile"
    },
    privacy: {
      releaseGate: {
        id: "privacy.railgun.profile",
        title: "Railgun privacy evidence",
        status: "blocked",
        summary: "Private transfer remains disabled until a passing privacy adapter profile is configured."
      }
    }
  };
}

function passkeyStub(overrides?: Partial<PlatformPasskeyAuthenticator>): PlatformPasskeyAuthenticator {
  return {
    async isPlatformPasskeyAvailable() {
      return true;
    },
    async createPasskey(input) {
      return {
        publicKeyX: ("0x" + "11".repeat(32)) as Hex,
        publicKeyY: ("0x" + "22".repeat(32)) as Hex,
        credentialIdHash: ("0x" + "33".repeat(32)) as Hex,
        rpId: input.rpId,
        origin: input.expectedOrigin
      };
    },
    async signWithPasskey() {
      throw new Error("not used in these tests");
    },
    ...overrides
  };
}

function gateIds(result: { status: string; gates?: readonly { id: string }[] }): string[] {
  return (result.gates ?? []).map(gate => gate.id);
}

void test("environment configuration keeps unset critical values as blocking sentinels", () => {
  const savedEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("EXPO_PUBLIC_LOOM_")) {
        delete process.env[key];
      }
    }

    const config = readEnvironmentConfiguration();
    assert.equal(config.network.chainId, 0);
    assert.equal(config.rpId, "");
    assert.equal(config.origin, "");

    const gates = configurationReadiness(config);
    const ids = gates.map(gate => gate.id);
    for (const required of [
      "config.chainId",
      "config.l1ChainId",
      "config.rpId",
      "config.origin",
      "config.entryPoint",
      "config.bundler",
      "config.factory",
      "config.passkeyValidator",
      "config.p256Mode"
    ]) {
      assert.ok(ids.includes(required), `expected gate ${required}`);
    }
    assert.ok(gates.every(gate => gate.status !== "passed"));
  } finally {
    process.env = savedEnv;
  }
});

void test("configurationReadiness passes a fully configured wallet", () => {
  assert.deepEqual(configurationReadiness(completeConfiguration()), []);
});

void test("account creation is blocked before configuration is complete", async () => {
  const config = { ...completeConfiguration(), rpId: "" };
  let touchedPasskey = false;
  const passkey = passkeyStub({
    async isPlatformPasskeyAvailable() {
      touchedPasskey = true;
      return true;
    }
  });

  const result = await preparePasskeyAccountCreation({
    config,
    passkey,
    userName: "user",
    displayName: "User",
    registrationChallenge: CHALLENGE
  });

  assert.equal(result.status, "blocked");
  assert.ok(gateIds(result).includes("config.rpId"));
  assert.equal(touchedPasskey, false, "must not touch the passkey authenticator with incomplete config");
});

void test("account creation is blocked without a registration challenge", async () => {
  const result = await preparePasskeyAccountCreation({
    config: completeConfiguration(),
    passkey: passkeyStub(),
    userName: "user",
    displayName: "User"
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(gateIds(result), ["passkey.registration.challenge.missing"]);
});

void test("account creation is ready but flags unprotected recovery", async () => {
  const result = await preparePasskeyAccountCreation({
    config: completeConfiguration(),
    passkey: passkeyStub(),
    userName: "user",
    displayName: "User",
    registrationChallenge: CHALLENGE
  });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.value.recoveryStatus, "unprotected-recovery");
    assert.ok(gateIds(result).includes("recovery.guardians.not-configured"));
  }
});

function privacyEnabledConfiguration(budget: MetadataBudget): MobileWalletConfiguration {
  const base = completeConfiguration();
  const context: PrivacyContext = { account: ACCOUNT, chainId: 11155111 };
  const railgunProfile = {
    protocol: "railgun",
    async metadataBudget() {
      return budget;
    }
  } as unknown as RailgunAdapterProfile;

  return {
    ...base,
    privacy: {
      railgunProfile,
      context,
      releaseGate: {
        id: "privacy.railgun.profile",
        title: "Railgun privacy evidence",
        status: "passed",
        summary: "Profile evidence passed for this test double."
      }
    }
  };
}

const RELAYER_BUDGET: MetadataBudget = {
  protocol: "railgun",
  chainId: 11155111,
  items: [
    { surface: "relayer", reveals: "submission timing and fee payer", required: true },
    { surface: "timing", reveals: "coarse usage pattern", required: false }
  ]
};

void test("private send stays blocked without adapter evidence", async () => {
  const result = await preparePrivateSend({
    config: completeConfiguration(),
    draft: {
      asset: TOKEN,
      amount: 1n,
      recipient: "0zk-recipient",
      maxFee: 1n,
      deadline: 1n
    }
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(gateIds(result), ["privacy.railgun.disabled"]);
});

void test("private send is blocked when the metadata budget is not acknowledged", async () => {
  const result = await preparePrivateSend({
    config: privacyEnabledConfiguration(RELAYER_BUDGET),
    draft: {
      asset: TOKEN,
      amount: 1n,
      recipient: "0zk-recipient",
      maxFee: 1n,
      deadline: 1n
    }
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(gateIds(result), ["privacy.metadata-budget.unacknowledged"]);
});

void test("private send is blocked when required metadata surfaces are missing from the acknowledgment", async () => {
  const result = await preparePrivateSend({
    config: privacyEnabledConfiguration(RELAYER_BUDGET),
    draft: {
      asset: TOKEN,
      amount: 1n,
      recipient: "0zk-recipient",
      maxFee: 1n,
      deadline: 1n,
      metadataBudget: { ...RELAYER_BUDGET, items: [] }
    }
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(gateIds(result), ["privacy.metadata-budget.incomplete"]);
});

void test("private send is ready once the full metadata budget is acknowledged", async () => {
  const result = await preparePrivateSend({
    config: privacyEnabledConfiguration(RELAYER_BUDGET),
    draft: {
      asset: TOKEN,
      amount: 1n,
      recipient: "0zk-recipient",
      maxFee: 1n,
      deadline: 1n,
      metadataBudget: RELAYER_BUDGET
    }
  });

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.value.protocol, "railgun");
    assert.deepEqual(result.value.metadataBudget, RELAYER_BUDGET);
  }
});

function sessionClientStub() {
  const calls: unknown[] = [];
  const client = {
    chainId: 11155111,
    account: ACCOUNT,
    grantSession(input: unknown) {
      calls.push(input);
      return { intent: input };
    }
  } as unknown as LoomClient;
  return { client, calls };
}

function sessionDraft(overrides?: Partial<SessionPermissionDraft>): SessionPermissionDraft {
  return {
    sessionKey: SESSION_KEY,
    target: TARGET,
    selector: SELECTOR,
    token: TOKEN,
    maxAmount: 1000n,
    validUntil: 2_000n,
    maxUses: 3,
    ...overrides
  };
}

void test("session grant validates the permission draft before touching the client", () => {
  const { client, calls } = sessionClientStub();
  const result = prepareSessionGrant({
    client,
    permission: sessionDraft({
      sessionKey: "0x0000000000000000000000000000000000000000" as Hex,
      maxAmount: 0n,
      maxUses: 0,
      validUntil: 500n
    }),
    origin: "",
    label: "test",
    now: 1_000n
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(gateIds(result).sort(), [
    "session.expiry.invalid",
    "session.key.invalid",
    "session.max-amount.invalid",
    "session.max-uses.invalid",
    "session.origin.missing"
  ]);
  assert.equal(calls.length, 0, "grantSession must not be called for an invalid draft");
});

void test("session grant forwards a valid draft with explicit limits", () => {
  const { client, calls } = sessionClientStub();
  const result = prepareSessionGrant({
    client,
    permission: sessionDraft(),
    origin: "https://dapp.example.org",
    label: "swap session",
    now: 1_000n
  });

  assert.equal(result.status, "ready");
  assert.equal(calls.length, 1);
  const forwarded = calls[0] as Record<string, unknown>;
  assert.equal(forwarded.maxAmount, 1000n);
  assert.equal(forwarded.validUntil, 2_000n);
  assert.equal(forwarded.maxUses, 3);
  assert.equal(forwarded.origin, "https://dapp.example.org");
});

void test("deployment manifest parsing rejects malformed input", async () => {
  const { parseDeploymentManifest, DeploymentManifestError } = await import("../src/loom/deployment/manifest");

  assert.throws(() => parseDeploymentManifest(null), DeploymentManifestError);
  assert.throws(() => parseDeploymentManifest({ chainId: 0 }), DeploymentManifestError);
  assert.throws(
    () =>
      parseDeploymentManifest({
        chainId: 11155111,
        entryPoint: ENTRY_POINT,
        accountFactory: FACTORY,
        passkeyValidator: VALIDATOR,
        p256VerifierMode: "fallback-contract",
        codehashes: {}
      }),
    /fallback-contract mode requires a p256Verifier address/
  );
  assert.throws(
    () =>
      parseDeploymentManifest({
        chainId: 11155111,
        entryPoint: ENTRY_POINT,
        accountFactory: FACTORY,
        passkeyValidator: VALIDATOR,
        p256VerifierMode: "native-precompile",
        codehashes: { factory: "0x1234" }
      }),
    /32-byte hash/
  );
});

void test("deployment verification blocks mismatched addresses and empty codehash sets", async () => {
  const { parseDeploymentManifest, verifyDeploymentAgainstManifest } = await import(
    "../src/loom/deployment/manifest"
  );

  const manifest = parseDeploymentManifest({
    chainId: 11155111,
    entryPoint: ENTRY_POINT,
    accountFactory: FACTORY,
    passkeyValidator: VALIDATOR,
    p256VerifierMode: "native-precompile",
    codehashes: { accountFactory: "0x" + "cd".repeat(32) }
  });

  assert.deepEqual(verifyDeploymentAgainstManifest(completeConfiguration(), manifest), []);

  const mismatched = {
    ...completeConfiguration(),
    deployment: {
      accountFactory: SESSION_KEY,
      passkeyValidator: VALIDATOR,
      p256VerifierMode: "fallback-contract" as const
    }
  };
  const gates = verifyDeploymentAgainstManifest(mismatched, manifest);
  const ids = gates.map(gate => gate.id).sort();
  assert.deepEqual(ids, ["deployment.manifest.factory", "deployment.manifest.p256-mode"]);

  const emptyHashes = parseDeploymentManifest({
    chainId: 11155111,
    entryPoint: ENTRY_POINT,
    accountFactory: FACTORY,
    passkeyValidator: VALIDATOR,
    p256VerifierMode: "native-precompile",
    codehashes: {}
  });
  assert.ok(
    verifyDeploymentAgainstManifest(completeConfiguration(), emptyHashes)
      .map(gate => gate.id)
      .includes("deployment.manifest.codehashes")
  );
});

void test("a custom transport override takes priority over the auto-built bundler transport", async () => {
  const { resolveBundlerTransport } = await import("../src/loom/client");

  const customTransport = {
    async sendUserOperation() {
      return { userOpHash: ("0x" + "aa".repeat(32)) as Hex };
    }
  };

  const withOverride = {
    ...completeConfiguration(),
    transport: customTransport
  };
  assert.equal(resolveBundlerTransport(withOverride), customTransport);

  const withoutOverride = completeConfiguration();
  const built = resolveBundlerTransport(withoutOverride);
  assert.notEqual(built, customTransport);
  assert.equal(typeof built?.sendUserOperation, "function");

  const withNeitherOverrideNorUrl = {
    ...completeConfiguration(),
    network: { ...completeConfiguration().network, bundlerUrl: undefined }
  };
  assert.equal(resolveBundlerTransport(withNeitherOverrideNorUrl), undefined);
});

void test("on-chain code hash confirmation reads bytecode through the state transport and matches it against the manifest", async () => {
  const { parseDeploymentManifest } = await import("../src/loom/deployment/manifest");
  const { verifyManifestCodehashesOnChain } = await import("../src/loom/deployment/onChainCodehash");

  const IMPLEMENTATION = "0x7777777777777777777777777777777777777777" as Hex;
  const ACCOUNT_IMPLEMENTATION_WORD = ("0x" + "00".repeat(12) + IMPLEMENTATION.slice(2)) as Hex;

  const bytecodeByAddress: Record<string, Hex> = {
    [ENTRY_POINT.toLowerCase()]: "0xaa",
    [FACTORY.toLowerCase()]: "0xbb",
    [VALIDATOR.toLowerCase()]: "0xcc",
    [IMPLEMENTATION.toLowerCase()]: "0xdd"
  };

  const manifest = parseDeploymentManifest({
    chainId: 11155111,
    entryPoint: ENTRY_POINT,
    accountFactory: FACTORY,
    passkeyValidator: VALIDATOR,
    p256VerifierMode: "native-precompile",
    codehashes: {
      entryPoint: "0xdb81b4d58595fbbbb592d3661a34cdca14d7ab379441400cbfa1b78bc447c365",
      accountFactory: "0x9f1a1ebcae59b0879e9fb23ad9f90461016010b02c4a57af0fab0ee41025b4aa",
      passkeyValidator: "0xeead6dbfc7340a56caedc044696a168870549a6a7f6f56961e84a54bd9970b8a",
      accountImplementation: "0x5302ff401477f0f1499f76107d0641580c296cc4ff88eca12c019e3af840821a"
    }
  });

  function stubTransport(overrides?: {
    getCode?: (input: { address: Hex }) => Promise<Hex>;
    ethCall?: (input: { to: Hex; data: Hex }) => Promise<Hex>;
  }) {
    return {
      async ethCall(input: { to: Hex; data: Hex }) {
        if (overrides?.ethCall) return overrides.ethCall(input);
        return ACCOUNT_IMPLEMENTATION_WORD;
      },
      async getCode(input: { address: Hex }) {
        if (overrides?.getCode) return overrides.getCode(input);
        const bytecode = bytecodeByAddress[input.address.toLowerCase()];
        assert.ok(bytecode, `no fixture bytecode for ${input.address}`);
        return bytecode;
      }
    };
  }

  // Everything matches: no gates.
  assert.deepEqual(await verifyManifestCodehashesOnChain(manifest, stubTransport()), []);

  // A mismatched deployed implementation is caught even though the address lookup succeeded.
  const tamperedImplementation = stubTransport({
    async getCode(input) {
      if (input.address.toLowerCase() === IMPLEMENTATION.toLowerCase()) {
        return "0xdeadbeef";
      }
      return bytecodeByAddress[input.address.toLowerCase()] as Hex;
    }
  });
  const mismatchGates = await verifyManifestCodehashesOnChain(manifest, tamperedImplementation);
  assert.deepEqual(
    mismatchGates.map(gate => gate.id),
    ["deployment.onchain.accountImplementation.mismatch"]
  );

  // No bytecode at the factory address at all (not deployed on this chain).
  const undeployed = stubTransport({
    async getCode(input) {
      if (input.address.toLowerCase() === FACTORY.toLowerCase()) {
        return "0x";
      }
      return bytecodeByAddress[input.address.toLowerCase()] as Hex;
    }
  });
  const undeployedGates = await verifyManifestCodehashesOnChain(manifest, undeployed);
  assert.ok(undeployedGates.some(gate => gate.id === "deployment.onchain.accountFactory.not-deployed"));

  // A state transport without getCode/ethCall support cannot confirm anything and says so.
  const noSupport = { async ethCall() { throw new Error("unsupported"); } };
  const noSupportGates = await verifyManifestCodehashesOnChain(manifest, noSupport);
  assert.ok(noSupportGates.every(gate => gate.status === "blocked"));
  assert.ok(noSupportGates.some(gate => gate.id === "deployment.onchain.entryPoint.no-getcode-support"));
});

void test("a loopback host relaxes the transport, not the scheme", async () => {
  const { assertEndpointUrl } = await import("../src/config/runtimeOverrides");
  const { MobileWalletConfigurationError } = await import("../src/platform/errors");

  assert.equal(assertEndpointUrl("https://bundler.example", "Bundler URL"), "https://bundler.example");
  assert.equal(assertEndpointUrl("http://localhost:4337", "Bundler URL"), "http://localhost:4337");
  assert.equal(assertEndpointUrl("http://127.0.0.1:4337", "Bundler URL"), "http://127.0.0.1:4337");

  for (const rejected of [
    "ftp://localhost/bundler",
    "file://localhost/bundler",
    "ws://localhost:4337",
    "http://bundler.example"
  ]) {
    assert.throws(() => assertEndpointUrl(rejected, "Bundler URL"), MobileWalletConfigurationError, rejected);
  }
});

void test("the mobile passkey signer commits to the configured validator and EntryPoint", async () => {
  const { createMobilePasskeySigner } = await import("../src/loom/passkeySigner");
  const config = completeConfiguration();

  const signer = createMobilePasskeySigner({
    config,
    credentialIdHash: CREDENTIAL_ID_HASH,
    passkey: passkeyStub()
  });

  // These four are the construction-time commitments the SDK requires and this
  // wrapper never supplied, which is why it did not type-check at all.
  assert.equal(signer.validator.toLowerCase(), config.deployment.passkeyValidator?.toLowerCase());
  assert.equal(signer.entryPoint.toLowerCase(), config.network.entryPoint?.toLowerCase());
  assert.equal(signer.rpId, config.rpId);
  assert.equal(signer.origin, config.origin);
  assert.equal(signer.credentialId, CREDENTIAL_ID_HASH);
});

void test("the mobile passkey signer refuses to be built without deployment configuration", async () => {
  const { createMobilePasskeySigner } = await import("../src/loom/passkeySigner");
  const base = completeConfiguration();

  for (const config of [
    { ...base, deployment: { ...base.deployment, passkeyValidator: undefined } },
    { ...base, network: { ...base.network, entryPoint: undefined } }
  ] as MobileWalletConfiguration[]) {
    assert.throws(() =>
      createMobilePasskeySigner({ config, credentialIdHash: CREDENTIAL_ID_HASH, passkey: passkeyStub() })
    );
  }
});

void test("no deployment value can be missing without blocking before the authenticator", async () => {
  // The guarantee is that a credential is never created against configuration
  // the app has not fully resolved. It used to depend on configurationReadiness
  // and requireAccountDeploymentConfig listing the same fields; this pins it
  // per field so a future edit to either list cannot quietly break it.
  for (const field of ["accountFactory", "passkeyValidator"] as const) {
    const base = completeConfiguration();
    const config: MobileWalletConfiguration = {
      ...base,
      deployment: { ...base.deployment, [field]: undefined }
    };
    let touchedPasskey = false;
    const result = await preparePasskeyAccountCreation({
      config,
      passkey: passkeyStub({
        async createPasskey(passkeyInput) {
          touchedPasskey = true;
          return passkeyStub().createPasskey(passkeyInput);
        }
      }),
      userName: "user",
      displayName: "User",
      registrationChallenge: CHALLENGE
    });

    assert.equal(result.status, "blocked", `${field} must block account creation`);
    assert.equal(touchedPasskey, false, `${field} must block before a credential is created`);
  }

  const base = completeConfiguration();
  const withoutEntryPoint: MobileWalletConfiguration = {
    ...base,
    network: { ...base.network, entryPoint: undefined }
  };
  let touched = false;
  const result = await preparePasskeyAccountCreation({
    config: withoutEntryPoint,
    passkey: passkeyStub({
      async createPasskey(passkeyInput) {
        touched = true;
        return passkeyStub().createPasskey(passkeyInput);
      }
    }),
    userName: "user",
    displayName: "User",
    registrationChallenge: CHALLENGE
  });
  assert.equal(result.status, "blocked");
  assert.equal(touched, false, "entryPoint must block before a credential is created");
});
void test("malformed bytecode is a failure to confirm, not a thrown error", async () => {
  const { verifyManifestCodehashesOnChain } = await import("../src/loom/deployment/onChainCodehash");
  const { parseDeploymentManifest } = await import("../src/loom/deployment/manifest");
  const manifest = parseDeploymentManifest({
    chainId: 11155111,
    entryPoint: ENTRY_POINT,
    accountFactory: FACTORY,
    passkeyValidator: VALIDATOR,
    p256VerifierMode: "native-precompile",
    codehashes: { entryPoint: "0x" + "ab".repeat(32), accountFactory: "0x" + "cd".repeat(32) }
  });

  for (const malformed of ["0xabc", "0xzz"]) {
    const gates = await verifyManifestCodehashesOnChain(manifest, {
      async getCode() {
        return malformed as Hex;
      }
    } as never);
    assert.ok(gates.length > 0, `${malformed} must block rather than confirm`);
    assert.ok(
      gates.some(gate => gate.id.endsWith("malformed-bytecode") && gate.status === "blocked"),
      `${malformed} must be reported as unconfirmable bytecode`
    );
  }
});
