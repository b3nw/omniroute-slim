// Upstream #12626 through Slim's retained handleComboChat → dispatchWithCooldownRetry path:
//  - a single-target combo whose provider breaker is OPEN with a SHORT reset waits the breaker
//    out and re-dispatches instead of returning ALL_TARGETS_SKIPPED within milliseconds;
//  - an Overloaded STREAM_EARLY_EOF 502 never records a whole-provider breaker failure, while a
//    genuine 502 still does.
import test from "node:test";
import assert from "node:assert/strict";
import { handleComboChat } from "../../open-sse/services/combo.ts";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
  STATE,
} from "../../src/shared/utils/circuitBreaker.ts";

const silentLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.beforeEach(() => resetAllCircuitBreakers());
test.after(() => resetAllCircuitBreakers());

test("single-target combo waits out a short OPEN breaker and re-dispatches", async () => {
  const cb = getCircuitBreaker("deepseek");
  cb.state = STATE.OPEN;
  cb.resetTimeout = 200;
  cb.failureCount = 5;
  cb.failureThreshold = 3;
  cb.lastFailureTime = Date.now();

  let calls = 0;
  const started = Date.now();
  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    combo: { name: "combo-12626-wait", strategy: "priority", models: ["deepseek/deepseek-chat"] },
    handleSingleModel: async () => {
      calls++;
      return okResponse();
    },
    isModelAvailable: async () => true,
    log: silentLog,
    settings: null,
    relayOptions: null,
    allCombos: null,
  });

  assert.equal(result.status, 200, "the combo must recover once the short breaker reset passes");
  assert.equal(calls, 1);
  assert.ok(Date.now() - started >= 150, "the combo actually waited for the breaker reset");
});

async function dispatchFailure(provider: string, message: string) {
  return handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    combo: {
      name: `combo-12626-${provider}`,
      strategy: "priority",
      models: [`${provider}/some-model`],
    },
    handleSingleModel: async () => errorResponse(502, message),
    isModelAvailable: async () => true,
    log: silentLog,
    settings: { resilienceSettings: { comboCooldownWait: { enabled: false } } },
    relayOptions: null,
    allCombos: null,
  });
}

test("an Overloaded STREAM_EARLY_EOF 502 does not record a provider breaker failure", async () => {
  await dispatchFailure(
    "deepseek",
    "STREAM_EARLY_EOF: Stream ended before producing a non-ping SSE event: Overloaded"
  );
  assert.equal(getCircuitBreaker("deepseek").getStatus().failureCount, 0);
});

test("a genuine 502 without Overloaded still records a provider breaker failure", async () => {
  await dispatchFailure("deepseek", "Bad gateway from upstream");
  assert.ok(getCircuitBreaker("deepseek").getStatus().failureCount >= 1);
});
