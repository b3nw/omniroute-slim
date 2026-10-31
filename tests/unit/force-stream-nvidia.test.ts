// @ts-nocheck
// NVIDIA NIM (nvcf) buffers the whole reasoning + output before replying to a
// `stream: false` request (30s–80s TTFB on reasoning models such as
// google/gemma-4-31b-it), while `stream: true` returns SSE headers in ~1.2s.
// The nvidia registry entry is therefore `forceStream`, a per-connection
// `providerSpecificData.forceStream` boolean can override the registry default,
// an explicit client `stream: false` must not leak into the upstream body, and
// the combo per-target startup timeout must be disarmed as soon as 200 headers
// arrive — not after the forced SSE body has been fully drained.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-force-stream-nvidia-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { clearIdempotency } = await import("../../src/lib/idempotencyLayer.ts");
const { clearInflight } = await import("../../open-sse/services/requestDedup.ts");
const { resetAll: resetAccountSemaphores } =
  await import("../../open-sse/services/accountSemaphore.ts");
const { handleChatCore, clearUpstreamProxyConfigCache } =
  await import("../../open-sse/handlers/chatCore.ts");
const { resetPayloadRulesConfigForTests } = await import("../../open-sse/services/payloadRules.ts");
const { REGISTRY } = await import("../../open-sse/config/providers/index.ts");
const { validateProviderSpecificData } =
  await import("../../src/shared/validation/providerSpecificData.ts");
const { registerComboTargetTimeoutDisarm } =
  await import("../../open-sse/services/combo/comboAbortReasons.ts");

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const SSE_CHUNKS = [
  sseChunk({
    id: "chatcmpl-sse",
    object: "chat.completion.chunk",
    model: "google/gemma-4-31b-it",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }],
  }),
  sseChunk({
    id: "chatcmpl-sse",
    object: "chat.completion.chunk",
    model: "google/gemma-4-31b-it",
    choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }),
  "data: [DONE]\n\n",
];

function buildSseResponse(chunks = SSE_CHUNKS, { delayMs = 0, onChunk } = {}) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      onChunk?.(i);
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function buildJsonResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-json",
      object: "chat.completion",
      model: "google/gemma-4-31b-it",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function invokeChatCore({
  provider,
  model = "google/gemma-4-31b-it",
  body,
  providerSpecificData = {},
  respond,
  signal,
}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return respond ? respond(calls.at(-1)) : buildSseResponse();
  };

  try {
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider, model, extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
        ...(signal ? { signal } : {}),
      },
      connectionId: null,
      apiKeyInfo: null,
      userAgent: "unit-test",
      isCombo: false,
      comboStrategy: null,
      onCredentialsRefreshed: null,
      onRequestSuccess: null,
    });
    return { result, calls, call: calls.at(-1) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function resetStorage() {
  clearUpstreamProxyConfigCache();
  resetPayloadRulesConfigForTests();
  clearIdempotency();
  clearInflight();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetAccountSemaphores();
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── a. registry ──────────────────────────────────────────────────────────────

test("nvidia registry entry is forceStream", () => {
  assert.equal(REGISTRY.nvidia.forceStream, true);
});

// ── b. providerSpecificData validation ───────────────────────────────────────

function validationMessages(data) {
  const messages = [];
  const ctx = { addIssue: (issue) => messages.push(issue) };
  validateProviderSpecificData(data, ctx);
  return messages;
}

test("providerSpecificData.forceStream accepts booleans / unset and rejects other types", () => {
  assert.deepEqual(validationMessages({ forceStream: true }), []);
  assert.deepEqual(validationMessages({ forceStream: false }), []);
  assert.deepEqual(validationMessages({ forceStream: undefined }), []);
  assert.deepEqual(validationMessages({ forceStream: null }), []);

  for (const bad of ["true", 1, {}, []]) {
    const issues = validationMessages({ forceStream: bad });
    assert.equal(issues.length, 1, `expected one issue for ${JSON.stringify(bad)}`);
    assert.equal(issues[0].message, "providerSpecificData.forceStream must be a boolean");
    assert.deepEqual(issues[0].path, ["forceStream"]);
  }
});

// ── c. upstream stream forcing in handleChatCore ─────────────────────────────

const BASE_BODY = {
  model: "google/gemma-4-31b-it",
  messages: [{ role: "user", content: "hi" }],
};

for (const [label, clientStream] of [
  ["client omits stream", undefined],
  ["client sends stream:false", false],
]) {
  const body = clientStream === undefined ? BASE_BODY : { ...BASE_BODY, stream: clientStream };

  test(`nvidia (registry forceStream): ${label} → upstream stream:true, JSON reassembled`, async () => {
    const { result, call } = await invokeChatCore({ provider: "nvidia", body });

    assert.equal(call.body.stream, true, "upstream request must stream");
    assert.equal(result.success, true);
    assert.match(result.response.headers.get("content-type") || "", /application\/json/);
    const json = await result.response.json();
    assert.equal(json.choices[0].message.content, "Hello");
  });

  test(`openai-compatible + providerSpecificData.forceStream:true: ${label} → upstream stream:true`, async () => {
    const { result, call } = await invokeChatCore({
      provider: "openai-compatible-chat-forcestream",
      body,
      providerSpecificData: { baseUrl: "https://compat.example.com/v1", forceStream: true },
    });

    assert.equal(call.body.stream, true, "connection override must force upstream streaming");
    assert.equal(result.success, true);
    const json = await result.response.json();
    assert.equal(json.choices[0].message.content, "Hello");
  });

  test(`nvidia + providerSpecificData.forceStream:false: ${label} → upstream not streamed`, async () => {
    const { result, call } = await invokeChatCore({
      provider: "nvidia",
      body,
      providerSpecificData: { forceStream: false },
      respond: () => buildJsonResponse(),
    });

    assert.notEqual(call.body.stream, true, "connection override must disable forced streaming");
    assert.equal(result.success, true);
    const json = await result.response.json();
    assert.equal(json.choices[0].message.content, "Hello");
  });
}

// ── d. combo startup timeout disarmed at headers, not after body drain ───────

test("combo target startup timeout is disarmed on 200 headers, before the SSE body is drained", async () => {
  const controller = new AbortController();
  const events = [];
  registerComboTargetTimeoutDisarm(controller.signal, () => events.push("disarm"));

  const { result } = await invokeChatCore({
    provider: "nvidia",
    body: { ...BASE_BODY, stream: false },
    signal: controller.signal,
    respond: () =>
      buildSseResponse(SSE_CHUNKS, {
        delayMs: 20,
        onChunk: (i) => events.push(`chunk${i}`),
      }),
  });

  assert.equal(result.success, true);
  const json = await result.response.json();
  assert.equal(json.choices[0].message.content, "Hello");
  // The disarmer is reachable from both the client signal and the derived stream
  // signal (propagateComboTargetTimeoutDisarm), so it may run more than once —
  // the real runner disarm is idempotent. What matters is that it ran first.
  assert.equal(events[0], "disarm", `disarm must precede body chunks, got ${events.join(",")}`);
});

test("combo target startup timeout is NOT disarmed early when upstream headers are an error", async () => {
  const controller = new AbortController();
  const events = [];
  registerComboTargetTimeoutDisarm(controller.signal, () => events.push("disarm"));

  const { result } = await invokeChatCore({
    provider: "nvidia",
    body: { ...BASE_BODY, stream: false },
    signal: controller.signal,
    respond: () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
  });

  assert.equal(result.success, false);
  assert.deepEqual(events, [], "a failed attempt must keep the startup timer armed");
});
