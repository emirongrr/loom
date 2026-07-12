import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSdkRequestError,
  createAppScopeManager,
  createKohakuRuntime,
  createLoomSdk
} from "../src/index.js";
import {
  ConsentRequiredError,
  createConsentStore,
  createKohakuHost,
  providerConsentKey
} from "../../privacy/src/index.js";

const account = "0x1111111111111111111111111111111111111111";

const providerProfile = {
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
        mitigation: "user selected endpoint"
      }
    ]
  }
};

test("loom sdk construction has no provider side effects", () => {
  let calls = 0;
  const sdk = createLoomSdk({
    chainId: 1,
    account,
    kohaku: {
      host: createKohakuHost({
        providerProfile,
        fetch: async () => {
          calls += 1;
          return new Response("{}");
        }
      })
    }
  });

  assert.equal(sdk.lifecycle.buildSessionRevoke({ sessionKey: account }).kind, "session.revoke");
  assert.equal(calls, 0);
});

test("kohaku runtime requires explicit provider consent before network use", async () => {
  const runtime = createKohakuRuntime({
    host: createKohakuHost({
      providerProfile,
      fetch: async () => new Response("{}")
    })
  });

  await assert.rejects(runtime.request("https://rpc.example"), ConsentRequiredError);
});

test("kohaku runtime exposes a stable consent key for user-controlled providers", async () => {
  let calls = 0;
  const consentStore = createConsentStore();
  const runtime = createKohakuRuntime({
    host: createKohakuHost({
      providerProfile,
      consentStore,
      metadataPolicy: {
        allowedSurfaces: ["rpc"],
        requireKnownMitigation: true
      },
      fetch: async () => {
        calls += 1;
        return new Response("{}");
      }
    })
  });

  assert.equal(runtime.providerConsentKey, providerConsentKey(runtime.providerProfile));
  consentStore.grant(runtime.providerConsentKey);
  await runtime.request("https://rpc.example");
  assert.equal(calls, 1);
});

test("loom sdk rejects construction without an explicit kohaku host", () => {
  assert.throws(() => createLoomSdk({ chainId: 1, account }), InvalidSdkRequestError);
});

test("app scopes hash origins and strip path query and fragment", () => {
  const scopes = createAppScopeManager({ chainId: 1, account });
  const first = scopes.scopeForOrigin("https://app.example/swap?token=secret#fragment");
  const second = scopes.scopeForOrigin("https://app.example/portfolio");

  assert.equal(first.origin, "https://app.example");
  assert.equal(first.applicationId, second.applicationId);
  assert.equal(first.applicationId.includes("example"), false);
});

test("app scopes bind private scan context without exposing a global account graph", () => {
  const scopes = createAppScopeManager({ chainId: 1, account });
  const scope = scopes.scopeForOrigin("https://app.example");
  const context = scopes.bindPrivacyContext({ account, chainId: 1 }, scope);

  assert.equal(context.applicationId, scope.applicationId);
  assert.equal(context.scanScope, scope.applicationId);
  assert.equal("origin" in context, false);
});

test("app-scoped session grants preserve granular limits without leaking origin", () => {
  const sdk = createLoomSdk({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
  });
  const grant = sdk.buildAppSessionGrant({
    origin: "https://swap.example/path?pair=private",
    sessionKey: "0x2222222222222222222222222222222222222222",
    target: "0x3333333333333333333333333333333333333333",
    selector: "0x12345678",
    token: "0x4444444444444444444444444444444444444444",
    maxAmount: 100n,
    validUntil: 200n,
    maxUses: 2
  });

  assert.equal(grant.kind, "session.grant");
  assert.equal(grant.scope.maxUses, 2);
  assert.equal(grant.appScope.applicationId.startsWith("app:"), true);
  assert.equal("origin" in grant.appScope, false);
  assert.match(grant.appBindingHash, /^0x[0-9a-f]{64}$/);
  assert.equal(grant.review.summary.includes(grant.appBindingHash), true);
});

test("app-scoped session binding is deterministic across paths and query strings", () => {
  const sdk = createLoomSdk({
    chainId: 1,
    account,
    kohaku: { host: createKohakuHost({ providerProfile, fetch: async () => new Response("{}") }) }
  });
  const common = {
    sessionKey: "0x2222222222222222222222222222222222222222",
    target: "0x3333333333333333333333333333333333333333",
    selector: "0x12345678",
    token: "0x4444444444444444444444444444444444444444",
    maxAmount: 100n,
    validUntil: 200n,
    maxUses: 2
  };

  const first = sdk.buildAppSessionGrant({
    ...common,
    origin: "https://swap.example/a?secret=1"
  });
  const second = sdk.buildAppSessionGrant({
    ...common,
    origin: "https://swap.example/b?secret=2"
  });

  assert.equal(first.appScope.applicationId, second.appScope.applicationId);
  assert.equal(first.appBindingHash, second.appBindingHash);
});
