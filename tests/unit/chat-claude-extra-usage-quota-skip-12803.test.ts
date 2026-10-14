// Upstream #12803 through the retained handleChat → getProviderCredentials path: when the
// operator opted a Claude connection into extra usage (`blockExtraUsage: false`), an exhausted
// 5h session window must not hide the account pre-dispatch — Anthropic bills the overflow.
// With the default (blocking) policy the same cached exhaustion still parks the account.
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-claude-extra-usage-12803");
const {
  BaseExecutor,
  buildRequest,
  buildClaudeResponse,
  handleChat,
  resetStorage,
  seedConnection,
  settingsDb,
} = harness;
const quotaCache = await import("../../src/domain/quotaCache.ts");

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

async function runWithExhaustedSession(providerSpecificData: Record<string, unknown>) {
  const conn = await seedConnection("claude", {
    apiKey: "sk-claude-extra-usage",
    providerSpecificData,
  });
  quotaCache.setQuotaCache(conn.id, "claude", {
    "session (5h)": {
      remainingPercentage: 0,
      resetAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    },
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return buildClaudeResponse("ok");
  };
  const response = await handleChat(
    buildRequest({
      body: {
        model: "claude/claude-sonnet-4-5",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    })
  );
  return { response, calls };
}

test("extra-usage opt-in: an exhausted 5h window still dispatches to the account", async () => {
  const { response, calls } = await runWithExhaustedSession({ blockExtraUsage: false });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("default blocking policy: the same cached exhaustion parks the account pre-dispatch", async () => {
  const { response, calls } = await runWithExhaustedSession({});
  assert.equal(response.status, 429);
  assert.equal(calls, 0);
});
