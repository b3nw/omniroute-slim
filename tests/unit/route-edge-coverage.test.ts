import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-route-edges-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";
process.env.CLOUD_URL = "http://cloud.example";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const compliance = await import("../../src/lib/db/noLog.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const { updateSettings } = await import("@/lib/db/settings");
const { createProxy, assignProxyToScope } = await import("@/lib/db/proxies");
const { invalidateDbCache } = await import("@/lib/db/readCache");
const localDb = { updateSettings, createProxy, assignProxyToScope, invalidateDbCache };
const listKeysRoute = await import("../../src/app/api/keys/route.ts");
const settingsProxyRoute = await import("../../src/app/api/settings/proxy/route.ts");
const managementProxiesRoute = await import("../../src/app/api/v1/management/proxies/route.ts");
const audioSpeechRoute = await import("../../src/app/api/v1/audio/speech/route.ts");
const audioTranscriptionsRoute = await import("../../src/app/api/v1/audio/transcriptions/route.ts");
const moderationsRoute = await import("../../src/app/api/v1/moderations/route.ts");
const rerankRoute = await import("../../src/app/api/v1/rerank/route.ts");
const searchRoute = await import("../../src/app/api/v1/search/route.ts");
const videosRoute = await import("../../src/app/api/v1/videos/generations/route.ts");

const MACHINE_ID = "1234567890abcdef";

async function resetStorage() {
  delete process.env.ALLOW_API_KEY_REVEAL;
  delete process.env.INITIAL_PASSWORD;
  delete process.env.REQUIRE_API_KEY;
  delete process.env.ENABLE_SOCKS5_PROXY;

  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function enableManagementAuth() {
  process.env.INITIAL_PASSWORD = "bootstrap-password";
  await localDb.updateSettings({ requireLogin: true, password: "" });
}

async function createManagementKey() {
  return apiKeysDb.createApiKey("management", MACHINE_ID);
}

function makeRequest(url, { method = "GET", token, body, headers } = {}) {
  const requestHeaders = new Headers(headers);
  if (token) {
    requestHeaders.set("authorization", `Bearer ${token}`);
  }
  if (body !== undefined && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }

  return new Request(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedOpenAIConnection({
  email = "embeddings@example.com",
  provider = "openai",
  rateLimitedUntil = null,
} = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    email,
    name: email,
    apiKey: "sk-provider",
    testStatus: "active",
    lastError: null,
    lastErrorType: "token_refresh_failed",
    lastErrorSource: "oauth",
    errorCode: "refresh_failed",
    rateLimitedUntil,
    backoffLevel: 2,
    proxyEnabled: false,
  });
}

async function withPrepareFailure(match, message, fn) {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);

  db.prepare = (sql, ...args) => {
    const sqlText = String(sql);
    const matched = typeof match === "function" ? match(sqlText) : sqlText.includes(match);
    if (matched) {
      throw new Error(message);
    }
    return originalPrepare(sql, ...args);
  };

  try {
    return await fn();
  } finally {
    db.prepare = originalPrepare;
  }
}

async function withPrepareOverride(match, override, fn) {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);

  db.prepare = (sql, ...args) => {
    const sqlText = String(sql);
    const matched = typeof match === "function" ? match(sqlText) : sqlText.includes(match);
    const statement = originalPrepare(sql, ...args);
    if (!matched) {
      return statement;
    }
    return override({ sqlText, statement, args });
  };

  try {
    return await fn();
  } finally {
    db.prepare = originalPrepare;
  }
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("api keys route covers auth, create, masking, pagination fallback and cloud sync", async () => {
  await enableManagementAuth();

  const unauthenticated = await listKeysRoute.GET(new Request("http://localhost/api/keys"));
  const invalidToken = await listKeysRoute.GET(
    new Request("http://localhost/api/keys", {
      headers: { authorization: "Bearer sk-invalid" },
    })
  );
  await createManagementKey();

  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return Response.json({ changes: { apiKeys: 1 } });
  };

  try {
    await localDb.updateSettings({ cloudEnabled: true });

    const created = await listKeysRoute.POST(
      await makeManagementSessionRequest("http://localhost/api/keys", {
        method: "POST",
        body: { name: "Key / Prod #1", noLog: true },
      })
    );
    const createdBody = (await created.json()) as any;
    const stored = await apiKeysDb.getApiKeyById(createdBody.id);

    await apiKeysDb.createApiKey("Alpha", MACHINE_ID);
    await apiKeysDb.createApiKey("Beta", MACHINE_ID);

    const paged = await listKeysRoute.GET(
      await makeManagementSessionRequest("http://localhost/api/keys?limit=0&offset=-25")
    );

    const unauthenticatedBody = (await unauthenticated.json()) as any;
    const invalidTokenBody = (await invalidToken.json()) as any;
    const pagedBody = (await paged.json()) as any;

    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticatedBody.error.message, "Authentication required");
    assert.equal(invalidToken.status, 403);
    assert.equal(invalidTokenBody.error.message, "Invalid management token");

    assert.equal(created.status, 201);
    assert.equal(createdBody.name, "Key / Prod #1");
    assert.equal(createdBody.noLog, true);
    assert.match(createdBody.key, /^sk-/);
    assert.equal(stored?.noLog, true);
    assert.equal(compliance.isNoLog(createdBody.id), true);

    assert.equal(paged.status, 200);
    assert.equal(pagedBody.total, 4);
    assert.equal(pagedBody.keys.length, 4);
    assert.match(pagedBody.keys[0].key, /\*{4}/);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /^http:\/\/cloud\.example\/sync\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("api keys route rejects invalid payloads and malformed JSON", async () => {
  await enableManagementAuth();
  await createManagementKey();

  const missingName = await listKeysRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/keys", {
      method: "POST",
      body: {},
    })
  );

  const malformed = await listKeysRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
  );

  const malformedBody = (await malformed.json()) as any;

  assert.equal(missingName.status, 400);
  assert.equal(malformed.status, 500);
  assert.equal(malformedBody.error, "Failed to create key");
});

test("settings proxy route covers full config, resolve, validation, delete and global fallback", async () => {
  const providerConnection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "provider-conn",
    apiKey: "sk-openai",
  });

  const invalidJson = await settingsProxyRoute.PUT(
    new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    })
  );

  const invalidBody = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: { level: "provider", proxy: "bad-shape" },
    })
  );

  const validPut = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        level: "provider",
        id: "openai",
        proxy: { type: "http", host: "provider.local", port: "8080" },
        global: { type: "https", host: "global.local", port: "443" },
        combos: {
          primary: { type: "http", host: "combo.local", port: "9000" },
        },
        keys: {
          key1: { type: "https", host: "key.local", port: "9443" },
        },
      },
    })
  );
  const legacyPut = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        global: { type: "https", host: "global.local", port: "443" },
        combos: {
          primary: { type: "http", host: "combo.local", port: "9000" },
        },
        keys: {
          key1: { type: "https", host: "key.local", port: "9443" },
        },
      },
    })
  );

  const providerGet = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=provider&id=openai")
  );
  const resolveGet = await settingsProxyRoute.GET(
    new Request(`http://localhost/api/settings/proxy?resolve=${providerConnection.id}`)
  );
  const fullConfig = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy")
  );

  const registryProviderProxy = await localDb.createProxy({
    name: "Registry Provider Proxy",
    type: "http",
    host: "registry-provider.local",
    port: 8080,
    source: "dashboard-custom",
  });
  await localDb.assignProxyToScope("provider", "anthropic", registryProviderProxy.id);
  const registryProviderGet = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=provider&id=anthropic")
  );
  const fullConfigWithRegistryProvider = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy")
  );

  const deleted = await settingsProxyRoute.DELETE(
    new Request("http://localhost/api/settings/proxy?level=provider&id=openai", {
      method: "DELETE",
    })
  );
  const resolveAfterDelete = await settingsProxyRoute.GET(
    new Request(`http://localhost/api/settings/proxy?resolve=${providerConnection.id}`)
  );
  const missingLevel = await settingsProxyRoute.DELETE(
    new Request("http://localhost/api/settings/proxy", { method: "DELETE" })
  );

  const invalidJsonBody = (await invalidJson.json()) as any;
  const invalidBodyPayload = (await invalidBody.json()) as any;
  const validPutBody = (await validPut.json()) as any;
  const legacyPutBody = (await legacyPut.json()) as any;
  const providerGetBody = (await providerGet.json()) as any;
  const resolveBody = (await resolveGet.json()) as any;
  const fullConfigBody = (await fullConfig.json()) as any;
  const registryProviderGetBody = (await registryProviderGet.json()) as any;
  const fullConfigWithRegistryProviderBody = (await fullConfigWithRegistryProvider.json()) as any;
  const deletedBody = (await deleted.json()) as any;
  const resolveAfterDeleteBody = (await resolveAfterDelete.json()) as any;
  const missingLevelBody = (await missingLevel.json()) as any;

  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJsonBody.error.message, "Invalid JSON body");
  assert.equal(invalidBody.status, 400);
  assert.match(invalidBodyPayload.error.message, /invalid/i);

  assert.equal(validPut.status, 200);
  assert.equal(validPutBody.providers.openai.host, "provider.local");
  assert.equal(legacyPut.status, 200);
  assert.equal(legacyPutBody.global.host, "global.local");
  assert.equal(providerGet.status, 200);
  assert.equal(providerGetBody.proxy.host, "provider.local");
  assert.equal(resolveGet.status, 200);
  assert.equal(resolveBody.proxy.host, "provider.local");
  assert.equal(fullConfig.status, 200);
  assert.equal(fullConfigBody.global.host, "global.local");
  assert.equal(registryProviderGet.status, 200);
  assert.equal(registryProviderGetBody.proxy.host, "registry-provider.local");
  assert.equal(fullConfigWithRegistryProvider.status, 200);
  assert.equal(
    fullConfigWithRegistryProviderBody.providers.anthropic.host,
    "registry-provider.local"
  );
  assert.equal(deleted.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(deletedBody.providers, "openai"), false);
  assert.equal(resolveAfterDelete.status, 200);
  assert.equal(resolveAfterDeleteBody.level, "global");
  assert.equal(resolveAfterDeleteBody.proxy.host, "global.local");
  assert.equal(missingLevel.status, 400);
  assert.equal(missingLevelBody.error.message, "level is required");
});

test("settings proxy route resolves combo and key registry assignments with legacy fallback", async () => {
  const legacyPut = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        combos: {
          comboA: { type: "http", host: "legacy-combo.local", port: "9001" },
        },
        keys: {
          accountA: { type: "https", host: "legacy-key.local", port: "9444" },
        },
      },
    })
  );

  const legacyComboGet = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=combo&id=comboA")
  );
  const legacyKeyGet = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=key&id=accountA")
  );

  const comboProxy = await localDb.createProxy({
    name: "Registry Combo Proxy",
    type: "http",
    host: "registry-combo.local",
    port: 8181,
    username: "combo-user",
    password: "combo-secret",
  });
  const accountProxy = await localDb.createProxy({
    name: "Registry Account Proxy",
    type: "https",
    host: "registry-account.local",
    port: 9443,
    username: "account-user",
    password: "account-secret",
  });
  await localDb.assignProxyToScope("combo", "comboA", comboProxy.id);
  await localDb.assignProxyToScope("account", "accountA", accountProxy.id);

  const registryComboGet = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=combo&id=comboA")
  );
  const registryKeyGet = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=key&id=accountA")
  );

  const legacyPutBody = (await legacyPut.json()) as any;
  const legacyComboBody = (await legacyComboGet.json()) as any;
  const legacyKeyBody = (await legacyKeyGet.json()) as any;
  const registryComboBody = (await registryComboGet.json()) as any;
  const registryKeyBody = (await registryKeyGet.json()) as any;

  assert.equal(legacyPut.status, 200);
  assert.equal(legacyPutBody.combos.comboA.host, "legacy-combo.local");
  assert.equal(legacyPutBody.keys.accountA.host, "legacy-key.local");
  assert.equal(legacyComboGet.status, 200);
  assert.equal(legacyComboBody.level, "combo");
  assert.equal(legacyComboBody.id, "comboA");
  assert.equal(legacyComboBody.proxy.host, "legacy-combo.local");
  assert.equal(legacyKeyGet.status, 200);
  assert.equal(legacyKeyBody.level, "key");
  assert.equal(legacyKeyBody.id, "accountA");
  assert.equal(legacyKeyBody.proxy.host, "legacy-key.local");
  assert.equal(registryComboGet.status, 200);
  assert.equal(registryComboBody.proxy.host, "registry-combo.local");
  assert.equal(registryComboBody.proxy.username, "combo-user");
  assert.equal(registryComboBody.proxy.password, "combo-secret");
  assert.equal(registryKeyGet.status, 200);
  assert.equal(registryKeyBody.proxy.host, "registry-account.local");
  assert.equal(registryKeyBody.proxy.username, "account-user");
  assert.equal(registryKeyBody.proxy.password, "account-secret");
});

test("settings proxy route prefers proxy registry assignments and enforces socks5 feature gating", async () => {
  const created = await localDb.createProxy({
    name: "Global Proxy",
    type: "http",
    host: "registry.local",
    port: 8080,
    username: "alice",
    password: "secret",
  });
  await localDb.assignProxyToScope("global", null, created.id);

  const registryBacked = await settingsProxyRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=global")
  );
  const registryBackedBody = (await registryBacked.json()) as any;

  process.env.ENABLE_SOCKS5_PROXY = "false";
  const disabledSocks = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        level: "global",
        proxy: { type: "socks5", host: "127.0.0.1", port: "1080" },
      },
    })
  );

  process.env.ENABLE_SOCKS5_PROXY = "true";
  const enabledSocks = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        level: "global",
        proxy: { type: "SOCKS5", host: "127.0.0.1", port: "1080" },
      },
    })
  );

  const disabledSocksBody = (await disabledSocks.json()) as any;
  const enabledSocksBody = (await enabledSocks.json()) as any;

  assert.equal(registryBacked.status, 200);
  assert.equal(registryBackedBody.proxy.host, "registry.local");
  assert.equal(registryBackedBody.proxy.password, "secret");
  assert.equal(disabledSocks.status, 400);
  assert.match(disabledSocksBody.error.message, /SOCKS5 proxy is disabled/i);
  assert.equal(enabledSocks.status, 200);
  assert.equal(enabledSocksBody.global.type, "socks5");
});

test("settings proxy route covers default types, null maps, registry fallback, and server-error branches", async () => {
  const defaultTypePut = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        level: "global",
        proxy: { host: "default-type.local", port: "8088" },
      },
    })
  );
  assert.equal(defaultTypePut.status, 200);
  const defaultTypeBody = (await defaultTypePut.json()) as any;
  assert.equal(defaultTypeBody.global.type, "http");

  const clearMapPut = await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        global: null,
        providers: { openai: null },
      },
    })
  );
  assert.equal(clearMapPut.status, 200);
  const clearMapBody = (await clearMapPut.json()) as any;
  assert.equal(clearMapBody.global, null);
  assert.equal(Object.prototype.hasOwnProperty.call(clearMapBody.providers || {}, "openai"), false);

  await settingsProxyRoute.PUT(
    makeRequest("http://localhost/api/settings/proxy", {
      method: "PUT",
      body: {
        level: "global",
        proxy: { type: "https", host: "legacy-fallback.local", port: "9443" },
      },
    })
  );

  const missingRegistryProxy = await localDb.createProxy({
    name: "Missing Registry Proxy",
    type: "http",
    host: "missing-registry.local",
    port: 8080,
  });
  await localDb.assignProxyToScope("global", null, missingRegistryProxy.id);

  await withPrepareOverride(
    "FROM proxy_registry WHERE id = ?",
    ({ statement }) => ({
      ...statement,
      get() {
        return undefined;
      },
    }),
    async () => {
      const response = await settingsProxyRoute.GET(
        new Request("http://localhost/api/settings/proxy?level=global")
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.level, "global");
      assert.equal(body.proxy.host, "legacy-fallback.local");
    }
  );

  await withPrepareFailure(
    "SELECT key, value FROM key_value WHERE namespace = 'proxyConfig'",
    "proxy config read failure",
    async () => {
      const response = await settingsProxyRoute.GET(
        new Request("http://localhost/api/settings/proxy")
      );
      assert.equal(response.status, 500);
      assert.match((await response.json()).error.message, /proxy config read failure/i);
    }
  );

  await withPrepareFailure(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', 'global', ?)",
    "proxy config write failure",
    async () => {
      const response = await settingsProxyRoute.PUT(
        makeRequest("http://localhost/api/settings/proxy", {
          method: "PUT",
          body: {
            level: "global",
            proxy: { host: "broken-write.local", port: "8080" },
          },
        })
      );
      assert.equal(response.status, 500);
      const body = (await response.json()) as any;
      assert.equal(body.error.type, "server_error");
      assert.match(body.error.message, /proxy config write failure/i);
    }
  );

  await withPrepareFailure(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', 'global', ?)",
    "proxy config delete failure",
    async () => {
      const response = await settingsProxyRoute.DELETE(
        new Request("http://localhost/api/settings/proxy?level=global", {
          method: "DELETE",
        })
      );
      assert.equal(response.status, 500);
      assert.match((await response.json()).error.message, /proxy config delete failure/i);
    }
  );
});

test("management proxies route covers auth, pagination, lookup, where-used, patch and delete flows", async () => {
  await enableManagementAuth();
  await createManagementKey();

  const unauthenticated = await managementProxiesRoute.GET(
    new Request("http://localhost/api/v1/management/proxies")
  );
  const invalidToken = await managementProxiesRoute.GET(
    new Request("http://localhost/api/v1/management/proxies", {
      headers: { authorization: "Bearer sk-invalid" },
    })
  );

  const createdResponse = await managementProxiesRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/v1/management/proxies", {
      method: "POST",
      body: {
        name: "Branch Proxy",
        type: "http",
        host: "branch.local",
        port: 8080,
      },
    })
  );
  const created = (await createdResponse.json()) as any;
  await localDb.assignProxyToScope("provider", "openai", created.id);

  const pagedList = await managementProxiesRoute.GET(
    await makeManagementSessionRequest(
      "http://localhost/api/v1/management/proxies?limit=999&offset=-5"
    )
  );
  const byId = await managementProxiesRoute.GET(
    await makeManagementSessionRequest(
      `http://localhost/api/v1/management/proxies?id=${created.id}`
    )
  );
  const whereUsed = await managementProxiesRoute.GET(
    await makeManagementSessionRequest(
      `http://localhost/api/v1/management/proxies?id=${created.id}&where_used=1`
    )
  );
  const missingGet = await managementProxiesRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/v1/management/proxies?id=missing")
  );
  const invalidJsonPatch = await managementProxiesRoute.PATCH(
    await makeManagementSessionRequest("http://localhost/api/v1/management/proxies", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    })
  );
  const invalidPatch = await managementProxiesRoute.PATCH(
    await makeManagementSessionRequest("http://localhost/api/v1/management/proxies", {
      method: "PATCH",
      body: {},
    })
  );
  const patched = await managementProxiesRoute.PATCH(
    await makeManagementSessionRequest("http://localhost/api/v1/management/proxies", {
      method: "PATCH",
      body: { id: created.id, host: "patched.local", notes: "updated" },
    })
  );
  const missingDelete = await managementProxiesRoute.DELETE(
    await makeManagementSessionRequest("http://localhost/api/v1/management/proxies", {
      method: "DELETE",
    })
  );
  const conflictDelete = await managementProxiesRoute.DELETE(
    await makeManagementSessionRequest(
      `http://localhost/api/v1/management/proxies?id=${created.id}`,
      {
        method: "DELETE",
      }
    )
  );
  const forcedDelete = await managementProxiesRoute.DELETE(
    await makeManagementSessionRequest(
      `http://localhost/api/v1/management/proxies?id=${created.id}&force=1`,
      {
        method: "DELETE",
      }
    )
  );

  const unauthenticatedBody = (await unauthenticated.json()) as any;
  const invalidTokenBody = (await invalidToken.json()) as any;
  const pagedListBody = (await pagedList.json()) as any;
  const byIdBody = (await byId.json()) as any;
  const whereUsedBody = (await whereUsed.json()) as any;
  const missingGetBody = (await missingGet.json()) as any;
  const invalidJsonPatchBody = (await invalidJsonPatch.json()) as any;
  const invalidPatchBody = (await invalidPatch.json()) as any;
  const patchedBody = (await patched.json()) as any;
  const missingDeleteBody = (await missingDelete.json()) as any;
  const conflictDeleteBody = (await conflictDelete.json()) as any;
  const forcedDeleteBody = (await forcedDelete.json()) as any;

  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticatedBody.error.message, "Authentication required");
  assert.equal(invalidToken.status, 403);
  assert.equal(invalidTokenBody.error.message, "Invalid management token");
  assert.equal(createdResponse.status, 201);
  assert.equal(pagedList.status, 200);
  assert.equal(pagedListBody.page.limit, 200);
  assert.equal(pagedListBody.page.offset, 0);
  assert.equal(byId.status, 200);
  assert.equal(byIdBody.id, created.id);
  assert.equal(whereUsed.status, 200);
  assert.equal(whereUsedBody.count, 1);
  assert.equal(missingGet.status, 404);
  assert.equal(missingGetBody.error.message, "Proxy not found");
  assert.equal(invalidJsonPatch.status, 400);
  assert.equal(invalidJsonPatchBody.error.message, "Invalid JSON body");
  assert.equal(invalidPatch.status, 400);
  assert.equal(invalidPatchBody.error.message, "Invalid request");
  assert.equal(patched.status, 200);
  assert.equal(patchedBody.host, "patched.local");
  assert.equal(missingDelete.status, 400);
  assert.equal(missingDeleteBody.error.message, "id is required");
  assert.equal(conflictDelete.status, 409);
  assert.match(conflictDeleteBody.error.message, /force=true/i);
  assert.equal(forcedDelete.status, 200);
  assert.equal(forcedDeleteBody.success, true);
});

test("v1 routes surface provider-rate-limit sentinels instead of missing credentials", async () => {
  const validApiKey = await apiKeysDb.createApiKey("caller", MACHINE_ID);
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  await seedOpenAIConnection({ email: "openai-limited@example.com", rateLimitedUntil: retryAt });
  await seedOpenAIConnection({
    email: "runway-limited@example.com",
    provider: "runwayml",
    rateLimitedUntil: retryAt,
  });
  await seedOpenAIConnection({
    email: "cohere-limited@example.com",
    provider: "cohere",
    rateLimitedUntil: retryAt,
  });
  await seedOpenAIConnection({
    email: "serper-limited@example.com",
    provider: "serper-search",
    rateLimitedUntil: retryAt,
  });

  const token = validApiKey.key;
  const transcriptionForm = new FormData();
  transcriptionForm.set("model", "openai/whisper-1");

  const responses = [
    await moderationsRoute.POST(
      makeRequest("http://localhost/v1/moderations", {
        method: "POST",
        token,
        body: { model: "openai/omni-moderation-latest", input: "hello" },
      })
    ),
    await audioSpeechRoute.POST(
      makeRequest("http://localhost/v1/audio/speech", {
        method: "POST",
        token,
        body: { model: "openai/tts-1", input: "hello" },
      })
    ),
    await audioTranscriptionsRoute.POST(
      new Request("http://localhost/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: transcriptionForm,
      })
    ),
    await videosRoute.POST(
      makeRequest("http://localhost/v1/videos/generations", {
        method: "POST",
        token,
        body: { model: "runwayml/gen4.5", prompt: "a quiet wave" },
      })
    ),
    await rerankRoute.POST(
      makeRequest("http://localhost/v1/rerank", {
        method: "POST",
        token,
        body: { model: "cohere/rerank-v3.5", query: "hello", documents: ["hello world"] },
      })
    ),
    await searchRoute.POST(
      makeRequest("http://localhost/v1/search", {
        method: "POST",
        token,
        body: { provider: "serper-search", query: "hello", search_type: "web" },
      })
    ),
  ];

  for (const response of responses) {
    const body = (await response.json()) as any;
    assert.equal(response.status, 429);
    assert.match(body.error.message, /All accounts rate limited/);
    assert.ok(response.headers.get("retry-after"));
  }
});

