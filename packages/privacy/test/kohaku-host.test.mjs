import assert from "node:assert/strict";
import test from "node:test";
import {
  ConsentRequiredError,
  MetadataBudgetExceededError,
  createConsentStore,
  createKohakuHost,
  createMemoryStorage,
  createProviderProfile,
  providerConsentKey
} from "../src/index.js";

const profileInput = {
  mode: "user-rpc",
  chainId: 1,
  endpoint: "https://rpc.example",
  verified: false,
  metadataBudget: {
    protocol: "railgun",
    chainId: 1,
    items: [
      {
        surface: "rpc",
        reveals: "target chain and request timing",
        required: true,
        mitigation: "user-selected endpoint"
      }
    ]
  }
};

test("host construction does not query a default provider", () => {
  let calls = 0;
  createKohakuHost({
    providerProfile: profileInput,
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    }
  });

  assert.equal(calls, 0);
});

test("provider requests require explicit consent", async () => {
  let calls = 0;
  const host = createKohakuHost({
    providerProfile: profileInput,
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    }
  });

  await assert.rejects(host.network.fetch("https://rpc.example"), ConsentRequiredError);
  assert.equal(calls, 0);
});

test("provider requests run after consent and metadata policy approval", async () => {
  let calls = 0;
  const profile = createProviderProfile(profileInput);
  const consentStore = createConsentStore([providerConsentKey(profile)]);
  const host = createKohakuHost({
    providerProfile: profile,
    consentStore,
    metadataPolicy: {
      allowedSurfaces: ["rpc"],
      requireKnownMitigation: true
    },
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }));
    }
  });

  const response = await host.provider.request("https://rpc.example");

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("metadata policy rejects unapproved required surfaces", async () => {
  const host = createKohakuHost({
    providerProfile: {
      ...profileInput,
      metadataBudget: {
        ...profileInput.metadataBudget,
        items: [
          {
            surface: "relayer",
            reveals: "submission timing and fee intent",
            required: true,
            mitigation: "optional relayer"
          }
        ]
      }
    },
    metadataPolicy: {
      allowedSurfaces: ["rpc"]
    },
    fetch: async () => new Response("{}")
  });

  await assert.rejects(host.metadataBudget({ account: "0x1", chainId: 1 }), MetadataBudgetExceededError);
});

test("metadata policy can require mitigations for disclosing surfaces", async () => {
  const host = createKohakuHost({
    providerProfile: {
      ...profileInput,
      metadataBudget: {
        ...profileInput.metadataBudget,
        items: [
          {
            surface: "indexer",
            reveals: "private note scan window",
            required: true
          }
        ]
      }
    },
    metadataPolicy: {
      allowedSurfaces: ["indexer"],
      requireKnownMitigation: true
    },
    fetch: async () => new Response("{}")
  });

  await assert.rejects(host.metadataBudget({ account: "0x1", chainId: 1 }), MetadataBudgetExceededError);
});

test("memory storage is local to the host implementation", () => {
  const storage = createMemoryStorage({ "scan:railgun": "10" });

  assert.equal(storage.get("scan:railgun"), "10");
  storage.set("scan:railgun", "11");
  assert.equal(storage.get("scan:railgun"), "11");
  assert.equal(storage.get("scan:aztec"), null);
});
