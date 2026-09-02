import test from "node:test";
import assert from "node:assert/strict";
import {
  GeminiCliExecutor,
  buildGeminiCliHeaders,
  parseGeminiCliResetDuration,
  sanitizeGeminiCliError,
  GEMINI_CLI_ENDPOINT_FALLBACKS,
  GEMINI_CLI_UA_VERSION,
  GEMINI_CLI_NODE_CLIENT_VERSION,
  GEMINI_CLI_GL_NODE_VERSION,
  GEMINI_CLI_PLATFORM_ARCH,
} from "../../open-sse/executors/geminiCli.ts";
import { handleReasoningParameters } from "../../open-sse/translator/request/geminiCli.ts";
import {
  translateGeminiCliChunkToOpenAI,
  translateGeminiCliResponseToOpenAI,
  reassembleGeminiCliChunks,
} from "../../open-sse/translator/response/geminiCli.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import type { ProviderCredentials } from "../../open-sse/executors/base.ts";

// ============================================================================
// TIER 1: Header Generation, Parsing, and Basic Executor Wiring
// ============================================================================

test("Tier 1: buildGeminiCliHeaders constructs standard emulation headers", () => {
  const headers = buildGeminiCliHeaders("ya29.sample-token-123", "gemini-3.5-flash", {
    uaVersion: "0.31.0",
    nodeClientVersion: "10.6.1",
    glNodeVersion: "22.17.1",
    platformArch: "linux; x64",
  });

  assert.equal(headers.Authorization, "Bearer ya29.sample-token-123");
  assert.equal(headers["Content-Type"], "application/json");
  // Wire model for gemini-3.5-flash should be remapped to gemini-3-flash
  assert.equal(
    headers["User-Agent"],
    "GeminiCLI/0.31.0/gemini-3-flash (linux; x64) google-api-nodejs-client/10.6.1"
  );
  assert.equal(headers["X-Goog-Api-Client"], "gl-node/22.17.1");
  assert.equal(headers.Accept, "*/*");
  assert.equal(headers["Accept-Encoding"], "gzip, deflate, br");
  assert.equal(headers.Connection, "close");
});

test("Tier 1: parseGeminiCliResetDuration handles seconds, compound durations and text", () => {
  // Pure seconds
  assert.equal(parseGeminiCliResetDuration("2s"), 2000);
  assert.equal(parseGeminiCliResetDuration("515092.73s"), 515092730);

  // Embedded in human-readable text
  const text1 = "You have exhausted your capacity on this model. Your quota will reset after 2s.";
  assert.equal(parseGeminiCliResetDuration(text1), 2000);

  // Compound duration: 156h 14m 36.73s
  // 156 * 3600 + 14 * 60 + 36.73 = 561600 + 840 + 36.73 = 562476.73s -> 562476730ms
  const text2 = "Rate limit exceeded. Your quota will reset after 156h14m36.73s.";
  assert.equal(parseGeminiCliResetDuration(text2), 562476730);

  // Compound without fractional seconds
  const text3 = "Your quota will reset after 2h30m10s.";
  // 2 * 3600 + 30 * 60 + 10 = 7200 + 1800 + 10 = 9010s -> 9010000ms
  assert.equal(parseGeminiCliResetDuration(text3), 9010000);

  // Bare compound format
  assert.equal(parseGeminiCliResetDuration("156h14m36s"), 562476000);
  assert.equal(parseGeminiCliResetDuration("42m10s"), 2530000);

  // Invalid or null
  assert.equal(parseGeminiCliResetDuration(""), null);
  assert.equal(parseGeminiCliResetDuration(null), null);
  assert.equal(parseGeminiCliResetDuration("Generic rate limit without timing"), null);
});

test("Tier 1: sanitizeGeminiCliError redacts stack traces, paths, tokens and secrets", () => {
  const rawError = [
    "Error: Upstream request failed for token Bearer ya29.a0AfH6SMD_secret123 with client secret GOCSPX-secret_xyz",
    "    at Object.execute (/home/b3nw/projects/core/llm-proxy/OmniRoute/open-sse/executors/geminiCli.ts:145:12)",
    "    at async handleChatCore (/home/b3nw/projects/core/llm-proxy/OmniRoute/open-sse/handlers/chatCore.ts:89:9)",
  ].join("\n");

  const sanitized = sanitizeGeminiCliError(rawError);

  // Multi-line stack trace dropped
  assert.ok(!sanitized.includes("at Object.execute"));
  assert.ok(!sanitized.includes("handleChatCore"));

  // Paths redacted
  assert.ok(!sanitized.includes("/home/b3nw"));

  // Sensitive credentials redacted
  assert.ok(!sanitized.includes("ya29.a0AfH6SMD_secret123"));
  assert.ok(!sanitized.includes("GOCSPX-secret_xyz"));
  assert.ok(sanitized.includes("Bearer [REDACTED]") || sanitized.includes("[REDACTED_TOKEN]"));
});

test("Tier 1: GeminiCliExecutor buildUrl and buildHeaders methods", () => {
  const executor = new GeminiCliExecutor();
  const creds: ProviderCredentials = {
    apiKey: "test-key-123",
    providerSpecificData: {
      projectId: "proj-abc",
    },
  };

  const url0 = executor.buildUrl("gemini-3-flash", true, 0, creds);
  assert.equal(
    url0,
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
  );

  const url1 = executor.buildUrl("gemini-3-flash", true, 1, creds);
  assert.equal(
    url1,
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
  );

  const headers = executor.buildHeaders(creds, true, null, "gemini-3.5-flash");
  assert.equal(headers.Authorization, "Bearer test-key-123");
  assert.ok(headers["User-Agent"].includes("gemini-3-flash"));
});

// ============================================================================
// TIER 2: Execution Dispatch, countTokens, Streaming, and Fallback Resilience
// ============================================================================

test("Tier 2: GeminiCliExecutor.countTokens calls endpoint and parses response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({
        totalTokens: 128,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await executor.countTokens({
    model: "gemini-3-flash",
    body: {
      messages: [{ role: "user", content: "Test token count" }],
    },
    credentials: { apiKey: "token-count-key" },
    signal: null,
    log: null,
  });

  assert.ok(capturedUrl.endsWith("/v1internal:countTokens"));
  assert.deepEqual(result, {
    input_tokens: 128,
    provider: "gemini-cli",
    source: "provider",
  });
});

test("Tier 2: GeminiCliExecutor.execute streaming transformation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();

  const upstreamSse = [
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: "Thinking process...\n" }],
            },
          },
        ],
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: "Final stream output." }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 5,
          totalTokenCount: 20,
        },
      },
    })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  globalThis.fetch = (async () => {
    return new Response(upstreamSse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const execResult = await executor.execute({
    model: "gemini-3.5-flash",
    body: {
      messages: [{ role: "user", content: "Stream test" }],
    },
    stream: true,
    credentials: { apiKey: "stream-key", projectId: "test-proj" },
    signal: null,
    log: null,
  });

  assert.equal(execResult.response.status, 200);
  assert.equal(execResult.response.headers.get("Content-Type"), "text/event-stream");

  const reader = execResult.response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let receivedText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedText += decoder.decode(value, { stream: true });
  }

  assert.ok(receivedText.includes("Thinking process..."));
  assert.ok(receivedText.includes("Final stream output."));
  assert.ok(receivedText.includes("data: [DONE]"));
});

test("Tier 2: GeminiCliExecutor.execute non-streaming collection and reassembly", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();

  const upstreamSse = [
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "Non-streaming thought" },
                { text: "Non-streaming answer" },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          totalTokenCount: 30,
        },
      },
    })}\n\n`,
  ].join("");

  globalThis.fetch = (async () => {
    return new Response(upstreamSse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const execResult = await executor.execute({
    model: "gemini-3-flash",
    body: {
      messages: [{ role: "user", content: "Non-stream test" }],
    },
    stream: false,
    credentials: { apiKey: "non-stream-key" },
    signal: null,
    log: null,
  });

  assert.equal(execResult.response.status, 200);
  const json = (await execResult.response.json()) as {
    object: string;
    choices: Array<{
      message: { content?: string; reasoning_content?: string };
      finish_reason?: string;
    }>;
  };
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "Non-streaming answer");
  assert.equal(json.choices[0].message.reasoning_content, "Non-streaming thought");
  assert.equal(json.choices[0].finish_reason, "stop");
});

test("Tier 2: Upstream Endpoint Fallback - Fails over from Primary to Secondary on 5xx", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();
  const attemptedUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    attemptedUrls.push(url);

    if (url.startsWith("https://cloudcode-pa.googleapis.com")) {
      return new Response("Internal Server Error on Primary", { status: 500 });
    }

    if (url.startsWith("https://daily-cloudcode-pa.googleapis.com")) {
      const sse = `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "Secondary response" }] } }],
        },
      })}\n\n`;
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const result = await executor.execute({
    model: "gemini-3-flash",
    body: { messages: [{ role: "user", content: "Fallback test" }] },
    stream: false,
    credentials: { apiKey: "fallback-key" },
    signal: null,
    log: null,
  });

  assert.equal(result.response.status, 200);
  assert.equal(attemptedUrls.length, 2);
  assert.ok(attemptedUrls[0].includes("cloudcode-pa.googleapis.com"));
  assert.ok(attemptedUrls[1].includes("daily-cloudcode-pa.googleapis.com"));
});

test("Tier 2: 429 Rate Limit halts endpoint cycling immediately and extracts Retry-After", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();
  const attemptedUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    attemptedUrls.push(url);

    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          message:
            "You have exhausted your capacity on this model. Your quota will reset after 2s.",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await executor.execute({
    model: "gemini-3-flash",
    body: { messages: [{ role: "user", content: "Rate limit test" }] },
    stream: true,
    credentials: { apiKey: "rate-limit-key" },
    signal: null,
    log: null,
  });

  assert.equal(result.response.status, 429);
  // Must halt after first endpoint and NOT try production endpoint
  assert.equal(attemptedUrls.length, 1);
  assert.equal(result.response.headers.get("Retry-After"), "2");
});

// ============================================================================
// TIER 3: Reasoning & Thinking Configuration
// ============================================================================

test("Tier 3: handleReasoningParameters default behavior for Gemini 2.5 and Gemini 3", () => {
  // Gemini 2.5 default when no reasoning parameter is sent
  const gem25Default = handleReasoningParameters({}, "gemini-2.5-pro");
  assert.deepEqual(gem25Default, {
    thinkingBudget: -1,
    includeThoughts: true,
    include_thoughts: true,
  });

  // Gemini 3 Flash default when no reasoning parameter is sent
  const gem3FlashDefault = handleReasoningParameters({}, "gemini-3-flash");
  assert.deepEqual(gem3FlashDefault, {
    thinkingLevel: "high",
    includeThoughts: true,
    include_thoughts: true,
  });

  // Gemini 3 Pro default when no reasoning parameter is sent
  const gem3ProDefault = handleReasoningParameters({}, "gemini-3-pro-preview");
  assert.deepEqual(gem3ProDefault, {
    thinkingLevel: "high",
    includeThoughts: true,
    include_thoughts: true,
  });
});

test("Tier 3: handleReasoningParameters OpenAI reasoning_effort mapping", () => {
  // Effort: none/disable -> budget 0 / minimal with includeThoughts: false
  const gem25Disabled = handleReasoningParameters({ reasoning_effort: "none" }, "gemini-2.5-pro");
  assert.deepEqual(gem25Disabled, {
    thinkingBudget: 0,
    includeThoughts: false,
    include_thoughts: false,
  });

  const gem3Disabled = handleReasoningParameters({ reasoning_effort: "disable" }, "gemini-3-flash");
  assert.deepEqual(gem3Disabled, {
    thinkingLevel: "minimal",
    includeThoughts: false,
    include_thoughts: false,
  });

  // Effort: low / medium / high
  const gem25Low = handleReasoningParameters({ reasoning_effort: "low" }, "gemini-2.5-flash");
  assert.equal(gem25Low?.thinkingBudget, 6144);
  assert.equal(gem25Low?.includeThoughts, true);
  assert.equal(gem25Low?.include_thoughts, true);

  const gem3FlashMed = handleReasoningParameters({ reasoning_effort: "medium" }, "gemini-3-flash");
  assert.deepEqual(gem3FlashMed, {
    thinkingLevel: "medium",
    includeThoughts: true,
    include_thoughts: true,
  });
});

test("Tier 3: handleReasoningParameters Anthropic Claude thinking object mapping", () => {
  // Enabled with budget_tokens
  const claudeBudget = handleReasoningParameters(
    { thinking: { type: "enabled", budget_tokens: 8192 } },
    "gemini-2.5-pro"
  );
  assert.deepEqual(claudeBudget, {
    thinkingBudget: 8192,
    includeThoughts: true,
    include_thoughts: true,
  });

  // Disabled
  const claudeDisabled = handleReasoningParameters(
    { thinking: { type: "disabled" } },
    "gemini-2.5-flash"
  );
  assert.deepEqual(claudeDisabled, {
    thinkingBudget: 0,
    includeThoughts: false,
    include_thoughts: false,
  });
});

test("Tier 3: Response translation extracts reasoning_content for streaming and non-streaming", () => {
  // Streaming chunk with thought: true
  const streamingThoughtChunk = {
    responseId: "resp-123",
    candidates: [
      {
        content: {
          parts: [{ text: "Thinking about the problem step by step...", thought: true }],
        },
      },
    ],
  };

  const chunks = translateGeminiCliChunkToOpenAI(streamingThoughtChunk, "gemini-2.5-pro");
  assert.ok(Array.isArray(chunks));
  assert.equal(chunks.length, 1);
  assert.equal(
    (chunks[0].choices[0] as { delta: { reasoning_content?: string } }).delta.reasoning_content,
    "Thinking about the problem step by step..."
  );

  // Streaming chunk with thoughtSignature and text (reasoning without function call)
  const sigThoughtChunk = {
    responseId: "resp-124",
    candidates: [
      {
        content: {
          parts: [{ text: "Deep reasoning step...", thoughtSignature: "sig_abc" }],
        },
      },
    ],
  };
  const sigChunks = translateGeminiCliChunkToOpenAI(sigThoughtChunk, "gemini-3-flash");
  assert.ok(Array.isArray(sigChunks));
  assert.equal(
    (sigChunks[0].choices[0] as { delta: { reasoning_content?: string } }).delta.reasoning_content,
    "Deep reasoning step..."
  );

  // Non-streaming reassembly
  const reassembled = reassembleGeminiCliChunks(
    [
      {
        id: "chunk-1",
        choices: [{ delta: { reasoning_content: "Thought part 1. " } }],
      },
      {
        id: "chunk-2",
        choices: [{ delta: { reasoning_content: "Thought part 2." } }],
      },
      {
        id: "chunk-3",
        choices: [{ delta: { content: "Final answer." } }],
      },
    ],
    "gemini-2.5-pro"
  );

  const message = (reassembled.choices as Array<{ message: { content: string; reasoning_content: string } }>)[0].message;
  assert.equal(message.reasoning_content, "Thought part 1. Thought part 2.");
  assert.equal(message.content, "Final answer.");
});

test("Tier 3: Executor registry resolves gemini_cli and gcli aliases to GeminiCliExecutor", async () => {
  const exGeminiCli = await getExecutor("gemini_cli");
  assert.ok(exGeminiCli instanceof GeminiCliExecutor);

  const exGcli = await getExecutor("gcli");
  assert.ok(exGcli instanceof GeminiCliExecutor);

  const exDash = await getExecutor("gemini-cli");
  assert.ok(exDash instanceof GeminiCliExecutor);
});

