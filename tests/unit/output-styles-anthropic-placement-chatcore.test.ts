// @ts-nocheck
// #13383 (#12584) through the retained handleChatCore path: an output style applied to an
// Anthropic-shaped /v1/messages body must land in the top-level `system` field, never as a
// synthetic messages[0] system entry (which api.anthropic.com rejects with "messages.0: use the
// top-level 'system' parameter for the initial system prompt").
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-output-style-placement-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { updateCompressionSettings } = await import("../../src/lib/db/compression.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { OUTPUT_STYLE_MARKER } =
  await import("../../open-sse/services/compression/outputStyles/apply.ts");

const originalFetch = globalThis.fetch;

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function dispatchClaude(body) {
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = { url: String(url), body: JSON.parse(String(init.body || "{}")) };
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "OK" }],
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "claude", model: "claude-opus-5", extendedContext: false },
      credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json", "content-type": "application/json" }),
      },
      userAgent: "test-client/1.0",
    });
    return { result, captured };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function systemText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((block) => String(block?.text ?? "")).join("\n");
  return "";
}

test("chatCore: output style lands in Anthropic top-level system, messages[0] stays the user turn", async () => {
  await core.ensureDbInitialized();
  await updateCompressionSettings({
    enabled: true,
    outputStyles: [{ id: "terse-prose", level: "full" }],
  } as never);

  const { result, captured } = await dispatchClaude({
    model: "claude-opus-5",
    max_tokens: 64,
    system: [{ type: "text", text: "You are Claude." }],
    messages: [{ role: "user", content: "Summarize this API response." }],
    stream: false,
  });

  assert.equal(result.success, true);
  assert.ok(captured, "fetch was not called");
  const upstreamMessages = captured.body.messages;
  assert.equal(upstreamMessages[0].role, "user", "no synthetic system entry at messages[0]");
  assert.ok(
    upstreamMessages.every((message) => message.role !== "system"),
    "the instruction must not be injected as a system-role message on the Anthropic wire"
  );
  const text = systemText(captured.body.system);
  assert.match(text, /You are Claude\./, "client system prompt preserved");
  assert.ok(text.includes(OUTPUT_STYLE_MARKER), "output-style instruction placed in system");
  assert.equal(text.split(OUTPUT_STYLE_MARKER).length - 1, 1, "instruction injected exactly once");
});

test("chatCore: Claude-source → OpenAI target keeps the output style a leading system, never a demoted user turn", async () => {
  // Interaction with #12908: claude-to-openai demotes every system-role message after
  // index 0 to "user". Had the output style been unshifted onto the Claude messages[0]
  // (pre-#13383 placement), the translated body.system would precede it and the
  // instruction would reach the upstream as a USER turn. Placing it in the top-level
  // `system` keeps it inside the single leading system message.
  await core.ensureDbInitialized();
  await updateCompressionSettings({
    enabled: true,
    outputStyles: [{ id: "terse-prose", level: "full" }],
  } as never);

  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = { url: String(url), body: JSON.parse(String(init.body || "{}")) };
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const body = {
    model: "gpt-4o",
    max_tokens: 64,
    system: "You are Claude.",
    messages: [{ role: "user", content: "Summarize this API response." }],
    stream: false,
  };
  try {
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o", extendedContext: false },
      credentials: { apiKey: "test-openai-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json", "content-type": "application/json" }),
      },
      userAgent: "test-client/1.0",
    });
    assert.equal(result.success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured, "fetch was not called");
  const upstreamMessages = captured.body.messages;
  const systemIndices = upstreamMessages
    .map((message, index) => (message.role === "system" ? index : -1))
    .filter((index) => index >= 0);
  assert.deepEqual(systemIndices, [0], "exactly one leading system message");
  const leading = String(upstreamMessages[0].content);
  assert.match(leading, /You are Claude\./);
  assert.ok(leading.includes(OUTPUT_STYLE_MARKER), "instruction stays in the system message");
  assert.ok(
    upstreamMessages
      .filter((message) => message.role === "user")
      .every((message) => !String(message.content).includes(OUTPUT_STYLE_MARKER)),
    "instruction is never demoted into a user turn"
  );
});
