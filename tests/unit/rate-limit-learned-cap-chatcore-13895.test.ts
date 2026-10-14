// @ts-nocheck
// Upstream #13895 through Slim's retained handleChatCore upstream-error branch: a 429 whose body
// states a hard request cap ("Maximum N requests within M minutes") must be learned for the
// dispatching connection and rebuild its limiter paced under the cap (updateFromHeaders →
// updateFromResponseBody in open-sse/handlers/chatCore.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-learned-cap-chatcore-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const Bottleneck = (await import("bottleneck")).default;

const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  await rateLimitManager.__resetRateLimitManagerForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a 429 body cap on the chat path is learned and paces the rebuilt limiter", async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
  const updates = [];
  rateLimitManager.__setLimiterFactoryForTests((options) => {
    const limiter = new Bottleneck(options);
    const original = limiter.updateSettings.bind(limiter);
    limiter.updateSettings = (next) => {
      updates.push({ ...next });
      return original(next);
    };
    return limiter;
  });
  // A persisted connection with protection on: the chat path reconciles enablement from the DB.
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "chatcore-cap-conn",
    apiKey: "sk-test",
    rateLimitProtection: true,
  });
  const connectionId = connection.id;
  rateLimitManager.enableRateLimitProtection(connectionId);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "You have reached the request limit: Maximum 5 requests within 1 minutes",
          type: "rate_limit_error",
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );

  const body = {
    model: "gpt-4o-mini",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  };
  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
    credentials: { apiKey: "sk-test", connectionId, providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: structuredClone(body),
      headers: new Headers({ accept: "application/json" }),
    },
    userAgent: "learned-cap-chatcore-test",
  });
  globalThis.fetch = originalFetch;
  assert.equal(result.success, false);

  const learned = Object.values(rateLimitManager.getLearnedLimits()).find(
    (entry) => entry.connectionId === connectionId
  );
  assert.ok(learned, "the chat path must learn the body-stated cap");
  assert.equal(learned.capRequests, 5);
  assert.equal(learned.capWindowMs, 60_000);
  assert.equal(learned.minTime, 12_000);

  const capUpdate = updates.find((u) => u.reservoirRefreshAmount === 5);
  assert.ok(capUpdate, "the rebuilt limiter must be paced under the cap");
  assert.equal(capUpdate.reservoir, 0);
  assert.equal(capUpdate.minTime, 12_000);
});
