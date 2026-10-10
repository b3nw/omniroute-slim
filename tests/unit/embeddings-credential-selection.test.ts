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
