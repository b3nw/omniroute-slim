// A single-model request rejected pre-dispatch by handleNoCredentials (every account
// cooling down → 429/503, every account model-blocked → 401, …) short-circuits in
// handleSingleModelChat before handleChatCore, so it used to leave no trace: nothing
// in /dashboard/logs (call_logs) and nothing in the per-api-key usage counters
// (usage_history). It must now be recorded exactly once via recordRejectedRequestUsage,
// while combo rejections keep their single combo-level row.
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("single-model-nocreds-log");
const {
  BaseExecutor,
  buildRequest,
  buildOpenAIResponse,
  callLogsDb,
  combosDb,
  handleChat,
  resetStorage,
  seedApiKey,
  seedConnection,
  settingsDb,
} = harness;
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { describeRejectedResponse } = await import("../../src/sse/handlers/rejectedRequestUsage.ts");

const FUTURE = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

type CallLogRow = {
  status?: number;
  model?: string;
  provider?: string;
  apiKeyName?: string | null;
  comboName?: string | null;
  error?: string | null;
};

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  usageHistory.clearPendingRequests();
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
});

test.afterEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

async function callLogsFor(apiKeyName: string): Promise<CallLogRow[]> {
  // saveCallLog is awaited inside recordRejectedRequestUsage, but poll briefly in
  // case a later layer defers the write.
  let rows: CallLogRow[] = [];
  for (let i = 0; i < 50; i++) {
    const result = await callLogsDb.getCallLogs({ limit: 50 });
    const list = (Array.isArray(result) ? result : (result?.logs ?? [])) as CallLogRow[];
    rows = list.filter((row) => row.apiKeyName === apiKeyName);
    if (rows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return rows;
}

async function usageRowsFor(apiKeyId: string) {
  const rows = (await usageHistory.getUsageDb()).data.history as Array<{
    apiKeyId?: string | null;
    success?: boolean;
    status?: string;
    provider?: string;
  }>;
  return rows.filter((row) => row.apiKeyId === apiKeyId);
}

function stubFetch() {
  const counter = { calls: 0 };
  globalThis.fetch = async () => {
    counter.calls++;
    return buildOpenAIResponse("should-not-dispatch");
  };
  return counter;
}

function chat(model: string, authKey: string) {
  return handleChat(
    buildRequest({
      authKey,
      body: { model, stream: false, messages: [{ role: "user", content: "hi" }] },
    })
  );
}

test("all-accounts-rate-limited rejection is written to call_logs and usage_history", async () => {
  const key = await seedApiKey({ name: "nocreds-ratelimited" });
  await seedConnection("openai", { rateLimitedUntil: FUTURE() });
  const fetchCounter = stubFetch();

  const response = await chat("openai/gpt-4.1", key.key);
  assert.ok([429, 503].includes(response.status), `unexpected status ${response.status}`);
  assert.equal(fetchCounter.calls, 0, "the request must be rejected pre-dispatch");

  const logs = await callLogsFor("nocreds-ratelimited");
  assert.equal(logs.length, 1, "exactly one call_logs row for the rejection");
  assert.equal(logs[0].status, response.status);
  assert.equal(logs[0].provider, "openai");
  assert.equal(logs[0].comboName ?? null, null);
  assert.match(String(logs[0].error), new RegExp(`^\\[${response.status}\\] `));

  const usage = await usageRowsFor(key.id);
  assert.equal(usage.length, 1, "exactly one usage_history row for the rejection");
  assert.equal(usage[0].success, false);
  assert.equal(usage[0].status, String(response.status));

  // The client still receives the original, unconsumed error body.
  const body = (await response.json()) as { error?: { message?: string } };
  assert.equal(typeof body.error?.message, "string");
});

test("all-accounts-model-blocked rejection is logged (401, not a fake rate limit)", async () => {
  const key = await seedApiKey({ name: "nocreds-model-blocked" });
  await seedConnection("openai", {
    rateLimitedUntil: FUTURE(),
    providerSpecificData: { excludedModels: ["gpt-4.1"] },
  });
  const fetchCounter = stubFetch();

  const response = await chat("openai/gpt-4.1", key.key);
  assert.equal(response.status, 401);
  assert.equal(fetchCounter.calls, 0);

  const logs = await callLogsFor("nocreds-model-blocked");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 401);
  assert.match(String(logs[0].error), /No active credentials for provider: openai/);

  const usage = await usageRowsFor(key.id);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].success, false);
  assert.equal(usage[0].status, "401");
});

test("a successful single-model request does not produce a rejection row", async () => {
  const key = await seedApiKey({ name: "nocreds-success" });
  await seedConnection("openai");
  stubFetch();

  const response = await chat("openai/gpt-4.1", key.key);
  assert.equal(response.status, 200);
  const logs = await callLogsFor("nocreds-success");
  assert.ok(
    logs.every((row) => row.status === 200),
    "no rejected rows for a success"
  );
});

test("combo rejection is logged once at the combo level, not per inner target", async () => {
  const key = await seedApiKey({ name: "nocreds-combo" });
  await seedConnection("openai", { rateLimitedUntil: FUTURE() });
  await combosDb.createCombo({
    name: "nocreds-combo",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [{ kind: "model", model: "openai/gpt-4.1" }],
  });
  stubFetch();

  const response = await chat("nocreds-combo", key.key);
  assert.ok(response.status >= 400);

  const logs = await callLogsFor("nocreds-combo");
  assert.equal(logs.length, 1, "combo failure must not be double-logged");
  assert.equal(logs[0].comboName, "nocreds-combo");
});

test("describeRejectedResponse reads the error message without consuming the body", async () => {
  const response = new Response(JSON.stringify({ error: { message: "  all cooling  " } }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(await describeRejectedResponse(response, "fallback"), "[429] all cooling");
  assert.deepEqual(await response.json(), { error: { message: "  all cooling  " } });

  const plain = new Response("not json", { status: 503 });
  assert.equal(await describeRejectedResponse(plain, "No credentials"), "[503] No credentials");
});
