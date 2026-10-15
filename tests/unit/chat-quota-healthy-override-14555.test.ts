// Upstream #14555 (#14359) through the retained handleChat → getProviderCredentials path:
// a real upstream success arms the healthy override, so a later quota-monitor rewrite that
// marks the connection exhausted (e.g. a fully-used weekly window resetting days out) does
// not park it pre-dispatch. Without the override, the cached-exhaustion 429 names its source and earliest reset.
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-quota-healthy-14555");
const {
  BaseExecutor,
  buildRequest,
  buildOpenAIResponse,
  handleChat,
  resetStorage,
  seedConnection,
  settingsDb,
} = harness;
const quotaCache = await import("../../src/domain/quotaCache.ts");

const FAR_RESET = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString();

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  quotaCache.__clearForTests();
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
});

test.afterEach(async () => {
  quotaCache.__clearForTests();
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

function chatRequest() {
  return buildRequest({
    body: {
      model: "openai/gpt-4.1",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    },
  });
}

function markWeeklyExhausted(connectionId: string) {
  quotaCache.setQuotaCache(connectionId, "openai", {
    weekly: { remainingPercentage: 0, resetAt: FAR_RESET },
  });
}

test("cached exhaustion without a recent success parks the account and names the source", async () => {
  const conn = await seedConnection("openai", { apiKey: "sk-openai-parked" });
  markWeeklyExhausted(conn.id);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return buildOpenAIResponse("never");
  };
  const response = await handleChat(chatRequest());
  assert.equal(response.status, 429);
  const body = (await response.json()) as any;
  assert.match(
    String(body.error?.message || ""),
    /exhausted their quota \(cached quota state, no upstream attempt; earliest reset /
  );
  assert.equal(calls, 0, "a parked account is skipped pre-dispatch");
});

test("a real upstream success arms the healthy override across a quota-monitor exhaustion rewrite", async () => {
  const conn = await seedConnection("openai", { apiKey: "sk-openai-healthy" });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return buildOpenAIResponse("ok");
  };

  const first = await handleChat(chatRequest());
  assert.equal(first.status, 200);
  assert.equal(calls, 1);

  // Quota monitor now reports the weekly window fully used (reset days out).
  markWeeklyExhausted(conn.id);
  assert.equal(quotaCache.isQuotaExhaustedForRequest(conn.id, "openai", "gpt-4.1"), false);
  assert.equal(quotaCache.isAccountQuotaExhausted(conn.id), false);

  const second = await handleChat(chatRequest());
  assert.equal(second.status, 200, "a recently-successful account must still be dispatched");
  assert.equal(calls, 2);

  // A genuine upstream 429 dropping the override (markAccountExhaustedFrom429) is covered in
  // quota-healthy-override-14359.test.ts; openai 429s never mark quota exhaustion in chat.ts.
});

function buildResponsesSSE(model: string) {
  return new Response(
    [
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_scope",
          object: "response",
          status: "completed",
          model,
          output: [
            {
              id: "msg_scope",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function codexRequest(model: string) {
  return buildRequest({
    url: "http://localhost/v1/responses",
    body: { model: `codex/${model}`, stream: false, input: "hello" },
  });
}

test("the chat success hook arms the override only for the Codex bucket that succeeded", async () => {
  const conn = await seedConnection("codex", { apiKey: "sk-codex-scope" });
  let calls = 0;
  globalThis.fetch = async (_url, init: RequestInit = {}) => {
    calls++;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    return buildResponsesSSE(String(body.model || "gpt-5.5"));
  };

  const first = await handleChat(codexRequest("gpt-5.5"));
  assert.equal(first.status, 200);
  assert.equal(calls, 1);

  // Quota monitor rewrite: both the standard and the Spark buckets fully used.
  quotaCache.setQuotaCache(conn.id, "codex", {
    session: { remainingPercentage: 0, resetAt: FAR_RESET },
    weekly: { remainingPercentage: 0, resetAt: FAR_RESET },
    gpt_5_3_codex_spark_session: { remainingPercentage: 0, resetAt: FAR_RESET },
    gpt_5_3_codex_spark_weekly: { remainingPercentage: 0, resetAt: FAR_RESET },
  });

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(conn.id, "codex", "gpt-5.5"),
    false,
    "the standard bucket that just succeeded is stood down"
  );
  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(conn.id, "codex", "gpt-5.3-codex-spark"),
    true,
    "a standard Codex success must not stand the Spark bucket down"
  );
});
