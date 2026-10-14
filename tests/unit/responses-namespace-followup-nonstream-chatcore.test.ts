// @ts-nocheck
// #12996 / upstream #13769 through Slim's inline non-streaming /v1/responses leg in handleChatCore
// (Slim's retained equivalent of the excised nonStreamingClientTranslate module). A follow-up turn
// that relies on previous_response_id continuity re-declares no `type:"namespace"` tools, so the
// per-request identity ledger is empty; an `mcp__<server>__<leaf>` wire name must still come back
// as {namespace, name}. When the request DID declare its own tools, an unlisted `mcp__a__b` is a
// flat function tool and must keep its name (the #12839 ledger gate).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ns-followup-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function chatJson(wireName) {
  return {
    id: "chatcmpl_followup",
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
              id: "call_followup",
              type: "function",
              function: { name: wireName, arguments: JSON.stringify({ code: "1+1" }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function nonStreamResponses(body, wireName) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(chatJson(wireName)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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
      userAgent: "ns-followup-test",
    });
    assert.equal(result.success, true);
    const payload = await result.response.json();
    return payload.output.find((item) => item.type === "function_call");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("follow-up turn with no declared namespace tools still restores {namespace, name} (non-stream)", async () => {
  const item = await nonStreamResponses(
    {
      model: "gpt-4o-mini",
      stream: false,
      previous_response_id: "resp_prior",
      input: [{ type: "function_call_output", call_id: "call_prior", output: "ok" }],
    },
    "mcp__node_repl__js"
  );
  assert.ok(item, "expected a function_call output item");
  assert.deepEqual({ namespace: item.namespace, name: item.name }, {
    namespace: "mcp__node_repl",
    name: "js",
  });
});

test("declared tool ledger present: an unlisted flat mcp__a__b function keeps its name (non-stream)", async () => {
  const item = await nonStreamResponses(
    {
      model: "gpt-4o-mini",
      stream: false,
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "mcp__other",
              tools: [{ name: "read", parameters: { type: "object" } }],
            },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      ],
      tools: [{ type: "function", name: "mcp__memory__health", parameters: { type: "object" } }],
    },
    "mcp__memory__health"
  );
  assert.ok(item, "expected a function_call output item");
  assert.equal(item.namespace, undefined);
  assert.equal(item.name, "mcp__memory__health");
});

test("explicitly declared flat mcp__a__b function with no namespace declared keeps its name (non-stream)", async () => {
  const item = await nonStreamResponses(
    {
      model: "gpt-4o-mini",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
      tools: [
        { type: "function", name: "mcp__notion__API_get_self", parameters: { type: "object" } },
      ],
    },
    "mcp__notion__API_get_self"
  );
  assert.ok(item, "expected a function_call output item");
  assert.equal(item.namespace, undefined);
  assert.equal(item.name, "mcp__notion__API_get_self");
});
