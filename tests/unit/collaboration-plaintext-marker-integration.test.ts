// @ts-nocheck
// #14154 / upstream #14447 through Slim's retained call paths. Codex MultiAgent V2 treats a
// collaboration function_call's arguments as ciphertext unless the item carries the
// `encrypted_function_args: []` plaintext-delivery marker. Slim excised upstream's
// nonStreamingClientTranslate module; its inline non-streaming leg in handleChatCore, the
// streaming chat→Responses translator, and the handleResponsesCore transform stream must
// each restore {namespace, name} AND stamp the marker for collaboration calls only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-collab-marker-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { handleResponsesCore } = await import("../../open-sse/handlers/responsesHandler.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function requestBody(stream, namespace, leaf) {
  return {
    model: "gpt-4o-mini",
    stream,
    input: [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: namespace,
            tools: [{ name: leaf, parameters: { type: "object" } }],
          },
        ],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
    ],
  };
}

function toolCall(wireName) {
  return {
    index: 0,
    id: "call_collab",
    type: "function",
    function: { name: wireName, arguments: JSON.stringify({ message: "READY" }) },
  };
}

function chatJson(wireName) {
  return {
    id: "chatcmpl_collab",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", tool_calls: [toolCall(wireName)] },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function chatSse(wireName) {
  const chunk = {
    id: "chatcmpl_collab",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", tool_calls: [toolCall(wireName)] },
        finish_reason: "tool_calls",
      },
    ],
  };
  return "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n";
}

function mockUpstream(stream, wireName) {
  globalThis.fetch = async () =>
    new Response(stream ? chatSse(wireName) : JSON.stringify(chatJson(wireName)), {
      status: 200,
      headers: { "Content-Type": stream ? "text/event-stream" : "application/json" },
    });
}

function parseSseFrames(text) {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") return { event, data: null };
      try {
        return { event, data: JSON.parse(data) };
      } catch {
        return { event, data: null };
      }
    });
}

async function viaChatCore(stream, namespace, leaf) {
  mockUpstream(stream, `${namespace}__${leaf}`);
  try {
    const body = requestBody(stream, namespace, leaf);
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: structuredClone(body),
        headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
      },
      userAgent: "collab-marker-test",
    });
    assert.equal(result.success, true);
    if (!stream) {
      const payload = await result.response.json();
      return payload.output.find((item) => item.type === "function_call");
    }
    const frames = parseSseFrames(await result.response.text());
    const done = frames.find((f) => f.event === "response.output_item.done");
    return done?.data?.item;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const stream of [false, true]) {
  const leg = stream ? "streaming" : "non-streaming";

  test(`chatCore ${leg} /v1/responses: collaboration spawn_agent carries encrypted_function_args:[]`, async () => {
    const item = await viaChatCore(stream, "collaboration", "spawn_agent");
    assert.ok(item, "expected a function_call output item");
    assert.deepEqual(
      { namespace: item.namespace, name: item.name },
      { namespace: "collaboration", name: "spawn_agent" }
    );
    assert.deepEqual(item.encrypted_function_args, []);
  });

  test(`chatCore ${leg} /v1/responses: non-collaboration namespace never carries the marker`, async () => {
    const item = await viaChatCore(stream, "search", "web_search");
    assert.ok(item, "expected a function_call output item");
    assert.deepEqual(
      { namespace: item.namespace, name: item.name },
      { namespace: "search", name: "web_search" }
    );
    assert.equal(item.encrypted_function_args, undefined);
  });
}

test("handleResponsesCore: collaboration send_message carries the marker on output_item.done", async () => {
  mockUpstream(true, "collaboration__send_message");
  try {
    const result = await handleResponsesCore({
      body: requestBody(true, "collaboration", "send_message"),
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    assert.equal(result.success, true);
    const frames = parseSseFrames(await result.response.text());
    const done = frames.find(
      (f) => f.event === "response.output_item.done" && f.data?.item?.type === "function_call"
    );
    const item = done?.data?.item;
    assert.ok(item, "expected a function_call output_item.done");
    assert.deepEqual(
      { namespace: item.namespace, name: item.name },
      { namespace: "collaboration", name: "send_message" }
    );
    assert.deepEqual(item.encrypted_function_args, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
