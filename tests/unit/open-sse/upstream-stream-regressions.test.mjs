import test from "node:test";
import assert from "node:assert/strict";

const responses = await import("../../../open-sse/translator/response/openai-responses.ts");
const helpers = await import("../../../open-sse/translator/response/openai-responses/pureHelpers.ts");
const arrays = await import("../../../open-sse/utils/arrayContentDelta.ts");
const cursorErrors = await import("../../../open-sse/executors/cursor/cursorErrors.ts");

test("response.done resolves by terminal status", () => {
  assert.equal(helpers.resolveResponsesDoneEventType("response.done", { response: { status: "failed" } }), "response.failed");
  assert.equal(helpers.resolveResponsesDoneEventType("response.done", { response: { status: "cancelled" } }), "response.failed");
  assert.equal(helpers.resolveResponsesDoneEventType("response.done", { response: { status: "incomplete" } }), "response.incomplete");
  assert.equal(helpers.resolveResponsesDoneEventType("response.done", { response: { status: "completed" } }), "response.completed");
});

test("incomplete response.done produces length finish reason", () => {
  const state = { model: "gpt-test", chatId: "chat-test", created: 1 };
  const result = responses.openaiResponsesToOpenAIResponse(
    { type: "response.done", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    state
  );
  assert.equal(result.choices[0].finish_reason, "length");
});

test("typed content parts become content and reasoning strings", () => {
  const delta = { content: [
    { type: "thinking", thinking: [{ type: "text", text: "think" }] },
    { type: "text", text: "answer" },
  ] };
  assert.equal(arrays.normalizeArrayContentDelta(delta), true);
  assert.deepEqual(delta, { content: "answer", reasoning_content: "think" });
});

test("Cursor timeout recognition requires its explicit code", () => {
  assert.equal(cursorErrors.isCursorStreamTimeoutError(Object.assign(new Error("timeout"), { code: "CURSOR_STREAM_TIMEOUT" })), true);
  assert.equal(cursorErrors.isCursorStreamTimeoutError(new Error("cursor-agent stream timed out")), false);
});
