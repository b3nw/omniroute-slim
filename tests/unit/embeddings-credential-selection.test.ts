/**
 * /v1/embeddings credential selection regressions (Codex review round 1).
 *
 *  - API-key `allowedConnections` must restrict credential selection.
 *  - `options.connectionId` (dashboard model test / combo target) must force
 *    selection of that exact connection.
 *  - The requested model must reach getProviderCredentials so per-model
 *    lockouts skip the locked account.
 *  - A local quota-share 429 (enforceQuotaShare) must NOT cool the connection.
 *
 * Round 2:
 *  - Keyless local providers (ollama-local/lmstudio) must fail closed when the
 *    API key's allowlist matches no connection, instead of falling back to an
 *    anonymous localhost dispatch.
 *  - options.signal must reach the upstream fetch.
 *
 * Round 3:
 *  - Private/LAN provider nodes (authType "none") must honor the allowlist and
 *    pinned connection instead of skipping credential selection.
 *  - A pinned-but-unavailable keyless local connection must fail closed.
 *  - A registry-recognized bare model must not be replaced by the connection's
 *    defaultModel.
 *  - The combo target's abort signal must reach the upstream fetch.
 *
 * Round 4:
 *  - A successful embedding must be recorded in the spend, token-limit, and
 *    usage-history ledgers.
 *  - A valid OmniRoute key sent via x-api-key (no Anthropic headers) is accepted.
 *  - An unrestricted LAN provider node still hydrates its configured connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-embed-cred-select-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "embed-cred-select-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { createPool, upsertAllocations } = await import("../../src/lib/db/quotaPools.ts");
const { setModelCap } = await import("../../src/lib/db/quotaModelCaps.ts");
const { getQuotaStore, resetQuotaStoreSingleton } =
  await import("../../src/lib/quota/storeFactory.ts");
const { lockModel, clearModelLock } = await import("../../open-sse/services/accountFallback.ts");
const { createEmbeddingResponse } = await import("../../src/lib/embeddings/service.ts");
const { POST } = await import("../../src/app/api/v1/embeddings/route.ts");

const MODEL = "mistral-embed";

async function resetStorage() {
  resetQuotaStoreSingleton();
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(name: string, priority: number): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider: "mistral",
    authType: "apikey",
    name,
    apiKey: `key-${name}`,
    priority,
    isActive: true,
    testStatus: "active",
  });
  return (conn as Record<string, unknown>).id as string;
}

/** Mock fetch, recording the bearer key of every upstream call. */
function mockUpstream(status = 200) {
  const usedKeys: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedKeys.push((headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: "upstream failure" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return {
    usedKeys,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("allowedConnections option restricts embedding credential selection", async () => {
  await seedConnection("preferred", 1);
  const restrictedId = await seedConnection("restricted", 2);

  const upstream = mockUpstream();
  try {
    const res = await createEmbeddingResponse(
      { model: `mistral/${MODEL}`, input: "hello" },
      { allowedConnections: [restrictedId] }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.usedKeys, ["key-restricted"]);
  } finally {
    upstream.restore();
  }
});

test("allowedConnections with no matching provider connection fails closed", async () => {
  await seedConnection("preferred", 1);

  const upstream = mockUpstream();
  try {
    const res = await createEmbeddingResponse(
      { model: `mistral/${MODEL}`, input: "hello" },
      { allowedConnections: ["some-other-connection"] }
    );
    assert.equal(res.status, 400);
    assert.equal(upstream.usedKeys.length, 0, "no upstream call may be made");
  } finally {
    upstream.restore();
  }
});

test("POST /v1/embeddings forwards the API key's allowedConnections", async () => {
  await seedConnection("preferred", 1);
  const restrictedId = await seedConnection("restricted", 2);
  const apiKey = await apiKeysDb.createApiKey("embed-restricted-key", "machine-embed", [], {
    allowedConnections: [restrictedId],
  });

  const upstream = mockUpstream();
  try {
    const res = await POST(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey.key}`,
        },
        body: JSON.stringify({ model: `mistral/${MODEL}`, input: "hello" }),
      }),
      undefined
    );
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.usedKeys, ["key-restricted"]);
  } finally {
    upstream.restore();
  }
});

test("options.connectionId forces selection of the pinned connection", async () => {
  await seedConnection("preferred", 1);
  const pinnedId = await seedConnection("pinned", 2);

  const upstream = mockUpstream();
  try {
    const res = await createEmbeddingResponse(
      { model: `mistral/${MODEL}`, input: "hello" },
      { connectionId: pinnedId }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.usedKeys, ["key-pinned"]);
  } finally {
    upstream.restore();
  }
});

test("requested model reaches credential selection so per-model lockouts are honored", async () => {
  const lockedId = await seedConnection("locked", 1);
  await seedConnection("fallback", 2);
  lockModel("mistral", lockedId, MODEL, "quota_exhausted", 60_000);

  const upstream = mockUpstream();
  try {
    const res = await createEmbeddingResponse({ model: `mistral/${MODEL}`, input: "hello" });
    assert.equal(res.status, 200);
    assert.deepEqual(
      upstream.usedKeys,
      ["key-fallback"],
      "the account locked for this model must be skipped"
    );
  } finally {
    upstream.restore();
    clearModelLock("mistral", lockedId, MODEL);
  }
});

test("local quota-share 429 does not mark the connection unavailable", async () => {
  const connId = await seedConnection("shared", 1);
  const apiKeyId = "embed-quota-share-key";

  const pool = createPool({ connectionId: connId, name: "Embed Quota Share Pool" });
  upsertAllocations(pool.id, [{ apiKeyId, weight: 100, policy: "hard" }]);
  setModelCap({ poolId: pool.id, apiKeyId, model: MODEL, capValue: 1, capUnit: "requests" });
  const store = await getQuotaStore();
  await store.consume(
    apiKeyId,
    { poolId: `${pool.id}:model:${MODEL}`, unit: "requests", window: "hourly" },
    1
  );

  const upstream = mockUpstream();
  try {
    const res = await createEmbeddingResponse(
      { model: `mistral/${MODEL}`, input: "hello" },
      { apiKeyId, apiKeyName: "quota-share-key" }
    );
    assert.equal(res.status, 429, "the local quota-share block must surface as 429");
    assert.equal(upstream.usedKeys.length, 0, "the request must be rejected before upstream");

    // Give any (incorrect) fire-and-forget cooldown write a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const conn = (await providersDb.getProviderConnectionById(connId)) as Record<string, unknown>;
    assert.equal(conn.testStatus, "active", "healthy connection must not be cooled");
    assert.ok(!conn.rateLimitedUntil, "no rate-limit cooldown may be recorded");
  } finally {
    upstream.restore();
  }
});

/** Mock fetch recording every upstream URL and the signal it was given. */
function mockUpstreamCalls() {
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), signal: init?.signal });
    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("keyless local provider fails closed when the allowlist matches no connection", async () => {
  const upstream = mockUpstreamCalls();
  try {
    const res = await createEmbeddingResponse(
      { model: "ollama-local/nomic-embed-text", input: "hello" },
      { allowedConnections: ["some-other-connection"] }
    );
    assert.equal(res.status, 400);
    assert.equal(upstream.calls.length, 0, "no anonymous localhost dispatch may be made");
  } finally {
    upstream.restore();
  }
});

test("keyless local provider still falls back to localhost when unrestricted", async () => {
  const upstream = mockUpstreamCalls();
  try {
    const res = await createEmbeddingResponse({
      model: "ollama-local/nomic-embed-text",
      input: "hello",
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.match(upstream.calls[0].url, /localhost|127\.0\.0\.1/);
  } finally {
    upstream.restore();
  }
});

test("options.signal is forwarded to the upstream embedding fetch", async () => {
  await seedConnection("preferred", 1);
  const controller = new AbortController();

  const upstream = mockUpstreamCalls();
  try {
    const res = await createEmbeddingResponse(
      { model: `mistral/${MODEL}`, input: "hello" },
      { signal: controller.signal }
    );
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].signal, controller.signal);
  } finally {
    upstream.restore();
  }
});

// ─── Round 3 ──────────────────────────────────────────────────────────────────

const { createProviderNode } = await import("../../src/lib/db/providers/nodes.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");

/** Mock fetch recording URL, auth header, parsed body, and signal of each call. */
function mockUpstreamDetailed() {
  const calls: {
    url: string;
    authorization: string;
    body: Record<string, unknown>;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization") || "",
      body: init?.body ? JSON.parse(String(init.body)) : {},
      signal: init?.signal,
    });
    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function seedLanNode(prefix: string): Promise<string> {
  const node = (await createProviderNode({
    type: "openai-compatible-embeddings",
    name: `LAN ${prefix}`,
    prefix,
    apiType: "embeddings",
    baseUrl: "http://10.20.0.5:11434/v1",
  })) as Record<string, unknown>;
  return node.id as string;
}

test("LAN provider node fails closed when the allowlist matches none of its connections", async () => {
  await seedLanNode("lanrestrict1");
  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse(
      { model: "lanrestrict1/nomic-embed-text", input: "hello" },
      { allowedConnections: ["some-other-connection"] }
    );
    assert.equal(res.status, 400);
    assert.equal(upstream.calls.length, 0, "the allowlist must not be bypassed");
  } finally {
    upstream.restore();
  }
});

test("LAN provider node fails closed when the pinned connection does not exist", async () => {
  await seedLanNode("lanrestrict2");
  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse(
      { model: "lanrestrict2/nomic-embed-text", input: "hello" },
      { connectionId: "missing-connection" }
    );
    assert.equal(res.status, 400);
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test("LAN provider node uses the allowed connection when restricted", async () => {
  const nodeId = await seedLanNode("lanrestrict3");
  const conn = (await providersDb.createProviderConnection({
    provider: nodeId,
    authType: "apikey",
    name: "lan-conn",
    apiKey: "lan-key",
    priority: 1,
    isActive: true,
    testStatus: "active",
  })) as Record<string, unknown>;

  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse(
      { model: "lanrestrict3/nomic-embed-text", input: "hello" },
      { allowedConnections: [conn.id as string] }
    );
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.match(upstream.calls[0].url, /10\.20\.0\.5/);
  } finally {
    upstream.restore();
  }
});

test("LAN provider node stays keyless when unrestricted", async () => {
  await seedLanNode("lanrestrict4");
  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse({
      model: "lanrestrict4/nomic-embed-text",
      input: "hello",
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].authorization, "");
  } finally {
    upstream.restore();
  }
});

test("keyless local provider fails closed when the pinned connection is unavailable", async () => {
  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse(
      { model: "ollama-local/nomic-embed-text", input: "hello" },
      { connectionId: "missing-connection" }
    );
    assert.equal(res.status, 400);
    assert.equal(upstream.calls.length, 0, "no anonymous localhost dispatch may be made");
  } finally {
    upstream.restore();
  }
});

test("a registry-recognized bare model is not replaced by the connection defaultModel", async () => {
  await providersDb.createProviderConnection({
    provider: "mistral",
    authType: "apikey",
    name: "with-default",
    apiKey: "key-with-default",
    priority: 1,
    isActive: true,
    testStatus: "active",
    defaultModel: "mistral-large-latest",
  });

  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse({ model: MODEL, input: "hello" });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].body.model, MODEL);
  } finally {
    upstream.restore();
  }
});

test("combo target abort signal reaches the upstream embedding fetch", async () => {
  await seedConnection("combo-target", 1);
  await createCombo({
    name: "embed-signal-combo",
    strategy: "priority",
    models: [`mistral/${MODEL}`],
  });
  const controller = new AbortController();

  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse(
      { model: "embed-signal-combo", input: "hello" },
      { signal: controller.signal }
    );
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    const forwarded = upstream.calls[0].signal;
    assert.ok(forwarded, "a signal must reach the upstream fetch");
    assert.notEqual(forwarded, controller.signal, "must combine with the target's signal");
    controller.abort();
    assert.equal(forwarded!.aborted, true, "client aborts must still propagate");
  } finally {
    upstream.restore();
  }
});

// ─── Round 4 ──────────────────────────────────────────────────────────────────

const { updatePricing } = await import("../../src/lib/db/settings.ts");
const { getDailyTotal } = await import("../../src/domain/costRules.ts");
const { upsertTokenLimit, getWindowUsage, resetWindowIfElapsed, incrementWindowTokens } =
  await import("../../src/lib/db/tokenLimits.ts");

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("successful embedding is recorded in the spend, token, and usage ledgers", async () => {
  const connId = await seedConnection("ledger", 1);
  const apiKey = await apiKeysDb.createApiKey("embed-ledger-key", "machine-embed");
  await updatePricing({ mistral: { [MODEL]: { input: 1_000_000, output: 0 } } });
  const limit = upsertTokenLimit({ apiKeyId: apiKey.id, scopeType: "global", tokenLimit: 1000 });
  // Warm the window so the counter does not re-seed from usage_history (which
  // already holds this request's row) on its first write.
  incrementWindowTokens(limit.id, resetWindowIfElapsed(limit).windowStart, 0);

  const upstream = mockUpstream();
  try {
    const res = await createEmbeddingResponse(
      { model: `mistral/${MODEL}`, input: "hello" },
      { apiKeyId: apiKey.id, apiKeyName: "embed-ledger-key" }
    );
    assert.equal(res.status, 200);
  } finally {
    upstream.restore();
  }

  // 2 tokens at $1/token.
  assert.equal(getDailyTotal(apiKey.id), 2);

  await waitFor(() => getWindowUsage(limit) > 0);
  assert.equal(getWindowUsage(limit), 2);

  const db = core.getDbInstance();
  type UsageRow = { endpoint: string; api_key_id: string; connection_id: string };
  let row: UsageRow | undefined;
  await waitFor(() => {
    row = db.prepare("SELECT endpoint, api_key_id, connection_id FROM usage_history").get() as
      UsageRow | undefined;
    return Boolean(row);
  });
  assert.deepEqual(row, {
    endpoint: "/v1/embeddings",
    api_key_id: apiKey.id,
    connection_id: connId,
  });
});

test("POST /v1/embeddings accepts a valid key sent via x-api-key", async () => {
  await seedConnection("xapikey", 1);
  const apiKey = await apiKeysDb.createApiKey("embed-xapikey", "machine-embed");
  const originalRequireApiKey = process.env.REQUIRE_API_KEY;
  process.env.REQUIRE_API_KEY = "true";

  const upstream = mockUpstream();
  try {
    const res = await POST(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey.key },
        body: JSON.stringify({ model: `mistral/${MODEL}`, input: "hello" }),
      }),
      undefined
    );
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.usedKeys, ["key-xapikey"]);
  } finally {
    upstream.restore();
    if (originalRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
    else process.env.REQUIRE_API_KEY = originalRequireApiKey;
  }
});

test("unrestricted LAN provider node hydrates its configured connection", async () => {
  const nodeId = await seedLanNode("lanhydrate1");
  const conn = (await providersDb.createProviderConnection({
    provider: nodeId,
    authType: "apikey",
    name: "lan-hydrate-conn",
    apiKey: "lan-hydrate-key",
    priority: 1,
    isActive: true,
    testStatus: "active",
  })) as Record<string, unknown>;
  const apiKey = await apiKeysDb.createApiKey("embed-lan-hydrate", "machine-embed");

  const upstream = mockUpstreamDetailed();
  try {
    const res = await createEmbeddingResponse(
      { model: "lanhydrate1/nomic-embed-text", input: "hello" },
      { apiKeyId: apiKey.id }
    );
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.match(upstream.calls[0].url, /10\.20\.0\.5/);
  } finally {
    upstream.restore();
  }

  // The hydrated connection id reaches the usage ledger (and proxy resolution).
  const db = core.getDbInstance();
  let row: { connection_id: string } | undefined;
  await waitFor(() => {
    row = db.prepare("SELECT connection_id FROM usage_history").get() as typeof row;
    return Boolean(row);
  });
  assert.equal(row?.connection_id, conn.id);
});
