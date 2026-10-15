// Upstream #14438 (#13757) through the retained handleChat call path: a request-level /
// parameter-validation 400 would fail identically on every account of the same model, so
// src/sse/handlers/chat.ts must take the shouldSkipConnDisable() branch — no account cooldown,
// no rotation through sibling accounts. An account-specific 400 (credential text) still rotates.
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-request-scoped-400");
const { BaseExecutor, buildRequest, handleChat, resetStorage, seedConnection, settingsDb } =
  harness;
const providersDb = await import("../../src/lib/db/providers.ts");

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
});

test.afterEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

function json400(message: string) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

async function runWith400(message: string) {
  const first = await seedConnection("openai", { name: "openai-a", apiKey: "sk-openai-a" });
  const second = await seedConnection("openai", { name: "openai-b", apiKey: "sk-openai-b" });
  const authHeaders: string[] = [];
  globalThis.fetch = async (_url: any, init: any = {}) => {
    const headers = new Headers(init.headers || {});
    authHeaders.push(String(headers.get("authorization") || ""));
    return json400(message);
  };
  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4.1",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    })
  );
  const conns = await Promise.all(
    [first.id, second.id].map((id) => providersDb.getProviderConnectionById(id))
  );
  return { response, authHeaders, conns };
}

for (const [label, message] of [
  ["parameter-validation (max_tokens)", "max_tokens must be less than or equal to 8192"],
  ["malformed request", "messages must alternate between user and assistant roles"],
  ["extra inputs (#13757)", "_omnirouteSkipContextRelay: Extra inputs are not permitted"],
  ["unknown field (#13757)", "Unrecognized field 'foo_bar' in request body"],
]) {
  test(`${label} 400 neither cools the account down nor rotates through siblings`, async () => {
    const { response, authHeaders, conns } = await runWith400(message);
    assert.equal(response.status, 400);
    assert.equal(
      authHeaders.length,
      1,
      "the same request would fail identically on a sibling account; it must not be retried there"
    );
    for (const conn of conns) {
      assert.ok(!conn.rateLimitedUntil, `account ${conn.name} must not be rate-limited`);
      assert.notEqual(conn.testStatus, "unavailable");
      assert.ok(conn.isActive);
    }
  });
}

test("a 400 carrying rate-limit text is account scoped and still rotates to a sibling", async () => {
  const { authHeaders } = await runWith400(
    "Detected high-frequency non-compliant requests from you."
  );
  assert.ok(
    authHeaders.length >= 2,
    `rate-limit 400 must still fail over to a sibling account (calls=${authHeaders.length})`
  );
  assert.notEqual(authHeaders[0], authHeaders[1]);
});
