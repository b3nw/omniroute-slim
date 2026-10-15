// @ts-nocheck
// Upstream #13128 through Slim's inline non-streaming /v1/responses leg in handleChatCore
// (Slim's retained equivalent of the excised nonStreamingClientTranslate module). A Responses
// custom/freeform tool is sent upstream as a Chat function with an { input: string } schema;
// the non-stream reply must come back as a custom_tool_call carrying the raw input, and a forced
// `tool_choice: {type:"custom"}` must reach the provider as the normalized function choice.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-custom-tool-nonstream-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function chatJson(wireName, args) {
  return {
    id: "chatcmpl_custom",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_custom",
              type: "function",
              function: { name: wireName, arguments: args },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function nonStreamResponses(body, wireName, args) {
  let upstreamBody = null;
  globalThis.fetch = async (_url, init) => {
    upstreamBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify(chatJson(wireName, args)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "custom-tool-nonstream-test",
    });
    assert.equal(result.success, true);
    const payload = await result.response.json();
    return { payload, upstreamBody };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("non-stream: forced custom tool_choice maps upstream and the reply is a custom_tool_call", async () => {
  const { payload, upstreamBody } = await nonStreamResponses(
    {
      model: "gpt-4o-mini",
      stream: false,
      input: 'Call functions__exec with exactly: text("ok")',
      tools: [{ type: "custom", name: "functions__exec", description: "Execute freeform code" }],
      tool_choice: { type: "custom", name: "functions__exec" },
    },
    "functions__exec",
    JSON.stringify({ input: 'text("ok")' })
  );
  assert.deepEqual(upstreamBody.tool_choice, {
    type: "function",
    function: { name: "functions__exec" },
  });
  assert.equal(upstreamBody.tools[0].type, "function");
  assert.equal(upstreamBody.tools[0].function.name, "functions__exec");

  const item = payload.output.find((entry) => entry.call_id === "call_custom");
  assert.ok(item, "expected the tool call in output");
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.name, "functions__exec");
  assert.equal(item.input, 'text("ok")');
  assert.equal(item.status, "completed");
  assert.equal("arguments" in item, false);
});

test("non-stream: custom tool nested in a namespace restores custom_tool_call + {namespace, name}", async () => {
  const { payload, upstreamBody } = await nonStreamResponses(
    {
      model: "gpt-4o-mini",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
      tools: [
        {
          type: "namespace",
          name: "mcp__commands",
          tools: [{ type: "custom", name: "exec", description: "Execute freeform code" }],
        },
      ],
    },
    "mcp__commands__exec",
    JSON.stringify({ input: "pong" })
  );
  assert.equal(upstreamBody.tools[0].function.name, "mcp__commands__exec");
  const item = payload.output.find((entry) => entry.call_id === "call_custom");
  assert.ok(item, "expected the tool call in output");
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.input, "pong");
  assert.deepEqual(
    { namespace: item.namespace, name: item.name },
    {
      namespace: "mcp__commands",
      name: "exec",
    }
  );
});

test("non-stream: plain function tools are not reclassified as custom", async () => {
  const { payload } = await nonStreamResponses(
    {
      model: "gpt-4o-mini",
      stream: false,
      input: "go",
      tools: [
        { type: "custom", name: "functions__exec" },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
    },
    "lookup",
    JSON.stringify({ q: "x" })
  );
  const item = payload.output.find((entry) => entry.call_id === "call_custom");
  assert.equal(item.type, "function_call");
  assert.equal(item.name, "lookup");
  assert.equal(item.arguments, JSON.stringify({ q: "x" }));
});
