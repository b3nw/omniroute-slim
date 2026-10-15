// @ts-nocheck
// Upstream #14529 through Slim's retained handleChatCore compression block: with an operator
// engine map that derives a lossy plan (rtk), a header-less request runs the safe
// [session-dedup, lite] pair instead, while `x-omniroute-compression: allow-lossy` keeps rtk.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lossy-policy-chatcore-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { updateCompressionSettings } = await import("../../../src/lib/db/compression.ts");
const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");

const originalFetch = globalThis.fetch;
const NOISY = Array.from({ length: 40 }, () => "same noisy line").join("\n");

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function dispatch(extraHeaders: Record<string, string> = {}) {
  let captured = null;
  globalThis.fetch = async (_url, init = {}) => {
    captured = JSON.parse(String(init.body || "{}"));
    return new Response(
      JSON.stringify({
        id: "chatcmpl_lossy",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const body = {
    model: "gpt-4o-mini",
    stream: false,
    messages: [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "run", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: NOISY },
    ],
  };
  try {
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json", ...extraHeaders }),
      },
      userAgent: "lossy-policy-test",
    });
    assert.equal(result.success, true);
    return { result, captured };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("header-less requests run the safe pair; allow-lossy keeps the operator's rtk engine", async () => {
  await core.ensureDbInitialized();
  await updateCompressionSettings({
    enabled: true,
    enginesExplicit: true,
    engines: { rtk: { enabled: true } },
  } as never);

  const plain = await dispatch();
  const plainMeta = String(plain.result.response.headers.get("x-omniroute-compression") || "");
  assert.match(
    plainMeta,
    /^stacked\b/,
    `header-less plan must be the safe stacked pair: ${plainMeta}`
  );
  assert.ok(plain.captured, "the request was dispatched upstream");

  const optedIn = await dispatch({ "x-omniroute-compression": "allow-lossy" });
  const optedMeta = String(optedIn.result.response.headers.get("x-omniroute-compression") || "");
  assert.match(optedMeta, /^rtk\b/, `allow-lossy must keep rtk: ${optedMeta}`);
  assert.ok(optedIn.captured, "the request was dispatched upstream");
});
