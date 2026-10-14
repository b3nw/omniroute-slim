// Upstream #14529 through Slim's retained handleComboChat priority path (#2101 guard in combo.ts):
// a fallback-worthy 400 that only carries the wrapper words "Bad Request" / "invalid" is no longer
// body-specific and advances to the next target (the old substring chain stopped on them); an
// explicit stop row ("Invalid message format … malformed") still stops the combo.
import test from "node:test";
import assert from "node:assert/strict";
import { handleComboChat } from "../../open-sse/services/combo.ts";
import { resetAllCircuitBreakers } from "../../src/shared/utils/circuitBreaker.ts";

const silentLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

async function run(firstError: string) {
  const dispatched: string[] = [];
  const response = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    combo: {
      name: `combo-14529-${dispatched.length}-${firstError.length}`,
      strategy: "priority",
      models: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    },
    handleSingleModel: async (_body, modelStr) => {
      dispatched.push(modelStr);
      if (modelStr.startsWith("deepseek/")) {
        return new Response(JSON.stringify({ error: { message: firstError } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    isModelAvailable: async () => true,
    log: silentLog,
    settings: { resilienceSettings: { comboCooldownWait: { enabled: false } } },
    relayOptions: null,
    allCombos: null,
  });
  return { response, dispatched };
}

test.beforeEach(() => resetAllCircuitBreakers());

test("a Bad Request-wrapped role-order 400 advances to the next combo target", async () => {
  const { response, dispatched } = await run(
    "Bad Request: messages must alternate between user and assistant roles"
  );
  assert.equal(response.status, 200);
  assert.deepEqual(dispatched, ["deepseek/deepseek-chat", "openai/gpt-4o-mini"]);
});

test("an 'invalid'-worded empty-content 400 advances to the next combo target", async () => {
  const { response, dispatched } = await run("empty content is invalid for this request");
  assert.equal(response.status, 200);
  assert.deepEqual(dispatched, ["deepseek/deepseek-chat", "openai/gpt-4o-mini"]);
});

test("an explicit stop row still stops the combo on the first target", async () => {
  const { response, dispatched } = await run(
    "Invalid message format: the request body is malformed."
  );
  assert.equal(response.status, 400);
  assert.deepEqual(dispatched, ["deepseek/deepseek-chat"]);
});
