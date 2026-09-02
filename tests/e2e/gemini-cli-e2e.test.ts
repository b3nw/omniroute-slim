import test from "node:test";
import assert from "node:assert/strict";
import { GeminiCliExecutor } from "../../open-sse/executors/geminiCli.ts";
import {
  translateChatRequestToGeminiCli,
  mapModelToGeminiCliWire,
} from "../../open-sse/translator/request/geminiCli.ts";
import {
  translateGeminiCliChunkToOpenAI,
  translateGeminiCliResponseToOpenAI,
  reassembleGeminiCliChunks,
} from "../../open-sse/translator/response/geminiCli.ts";
import {
  storeGeminiThoughtSignature,
  getGeminiThoughtSignature,
  clearGeminiThoughtSignatures,
  clearGeminiThoughtSignatureMemoryForTests,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";

// ============================================================================
// TIER 4: Real-World End-to-End Scenarios using Production GeminiCliExecutor
// ============================================================================

test("Tier 4 Scenario 1: Non-Streaming Chat Completion with Reasoning Token Extraction", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();

  // Mock CCPA upstream endpoint
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      model?: string;
      request?: { generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } };
    };
    assert.equal(body.model, "gemini-3-flash");
    assert.equal(body.request?.generationConfig?.thinkingConfig?.thinkingLevel, "high");

    const sseChunks = [
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ thought: true, text: "Analyzing algorithm step by step..." }],
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
                parts: [{ text: "Quicksort has an average time complexity of O(n log n)." }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 18,
            candidatesTokenCount: 14,
            thoughtsTokenCount: 10,
            totalTokenCount: 42,
          },
        },
      })}\n\n`,
    ].join("");

    return new Response(sseChunks, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const result = await executor.execute({
    model: "gemini-3-flash",
    body: {
      model: "gemini-3-flash",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "Analyze time complexity of quicksort" }],
    },
    stream: false,
    credentials: {
      apiKey: "token-e2e-1",
      providerSpecificData: { projectId: "test-proj-e2e" },
    },
    signal: null,
    log: null,
  });

  assert.equal(result.response.status, 200);
  const completion = (await result.response.json()) as {
    object: string;
    choices: Array<{
      message: { content?: string; reasoning_content?: string };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  assert.equal(completion.object, "chat.completion");
  assert.equal(
    completion.choices[0].message.content,
    "Quicksort has an average time complexity of O(n log n)."
  );
  assert.equal(
    completion.choices[0].message.reasoning_content,
    "Analyzing algorithm step by step..."
  );
  assert.equal(completion.choices[0].finish_reason, "stop");
  assert.deepEqual(completion.usage, {
    prompt_tokens: 18,
    completion_tokens: 24,
    total_tokens: 42,
    completion_tokens_details: { reasoning_tokens: 10 },
  });
});

test("Tier 4 Scenario 2: High-Throughput Streaming with Wire Model Remapping", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
    // gemini-3.5-flash must be remapped to gemini-3-flash on wire
    assert.equal(body.model, "gemini-3-flash");

    const sseChunks = [
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "Hello " }] } }],
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "world!" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        },
      })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    return new Response(sseChunks, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const result = await executor.execute({
    model: "gemini-3.5-flash",
    body: {
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "Say hello" }],
    },
    stream: true,
    credentials: {
      apiKey: "token-e2e-2",
      providerSpecificData: { projectId: "test-proj-e2e" },
    },
    signal: null,
    log: null,
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");

  const reader = result.response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  const parsedChunks: Array<{
    choices?: Array<{
      delta?: { content?: string; reasoning_content?: string };
      finish_reason?: string;
    }>;
    usage?: unknown;
  }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") continue;
      try {
        parsedChunks.push(JSON.parse(dataStr));
      } catch {}
    }
  }

  assert.ok(parsedChunks.length >= 2);
  for (const chunk of parsedChunks) {
    // Client receives chunks preserving original requested model
    assert.equal(chunk.model, "gemini-3.5-flash");
  }

  const textOutput = parsedChunks.map((c) => c.choices[0].delta?.content || "").join("");
  assert.equal(textOutput, "Hello world!");
});

test("Tier 4 Scenario 3: Multi-Turn Agentic Flow with Parallel Tool Calling & Thought Signature Continuity", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearGeminiThoughtSignatureMemoryForTests();
  });

  clearGeminiThoughtSignatureMemoryForTests();
  const executor = new GeminiCliExecutor();
  let turn = 1;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      request?: {
        contents?: Array<{
          role: string;
          parts: Array<{
            thoughtSignature?: string;
            functionResponse?: { id: string };
          }>;
        }>;
      };
    };

    if (turn === 1) {
      // Turn 1: Upstream produces 2 parallel function calls with thoughtSignature on first
      const sseChunks = [
        `data: ${JSON.stringify({
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: "gemini3_readFile",
                        args: { path: "config.json" },
                        id: "call_read_1",
                      },
                      thoughtSignature: "sig_e2e_turn1_valid",
                    },
                    {
                      functionCall: {
                        name: "gemini3_fetchStatus",
                        args: { service: "auth" },
                        id: "call_status_2",
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
        })}\n\n`,
      ].join("");
      return new Response(sseChunks, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    } else {
      // Turn 2: Verify thought signature re-injection and tool response consolidation
      const contents = body.request?.contents || [];
      const assistantMsg = contents[1];
      const toolResponsesMsg = contents[2];

      // Thought signature re-injected on first function call
      assert.equal(assistantMsg.parts[0].thoughtSignature, "sig_e2e_turn1_valid");
      // Tool responses consolidated into single user message
      assert.equal(toolResponsesMsg.role, "user");
      assert.equal(toolResponsesMsg.parts.length, 2);
      assert.equal(toolResponsesMsg.parts[0].functionResponse?.id, "call_read_1");
      assert.equal(toolResponsesMsg.parts[1].functionResponse?.id, "call_status_2");

      const sseChunks = [
        `data: ${JSON.stringify({
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "Config is valid and auth service is healthy." }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 45, candidatesTokenCount: 15, totalTokenCount: 60 },
          },
        })}\n\n`,
      ].join("");
      return new Response(sseChunks, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
  }) as typeof fetch;

  const tools = [
    {
      type: "function",
      function: {
        name: "readFile",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "fetchStatus",
        parameters: { type: "object", properties: { service: { type: "string" } } },
      },
    },
  ];

  // Turn 1 Execution
  const turn1Result = await executor.execute({
    model: "gemini-3-flash",
    body: {
      messages: [{ role: "user", content: "Check system config and status" }],
      tools,
    },
    stream: false,
    credentials: {
      apiKey: "token-agentic",
      providerSpecificData: { projectId: "proj-agentic" },
    },
    signal: null,
    log: null,
  });

  assert.equal(turn1Result.response.status, 200);
  const turn1Completion = (await turn1Result.response.json()) as {
    choices: Array<{
      finish_reason: string;
      message: {
        role: string;
        content: string | null;
        tool_calls: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };
  const turn1Choice = turn1Completion.choices[0];
  assert.equal(turn1Choice.finish_reason, "tool_calls");
  assert.ok(turn1Choice.message.tool_calls);
  assert.equal(turn1Choice.message.tool_calls.length, 2);
  assert.equal(turn1Choice.message.tool_calls[0].function.name, "readFile");
  assert.equal(turn1Choice.message.tool_calls[1].function.name, "fetchStatus");

  // Verify signature was stored in geminiThoughtSignatureStore
  assert.equal(getGeminiThoughtSignature("call_read_1"), "sig_e2e_turn1_valid");

  // Turn 2 Execution
  turn = 2;
  const turn2Result = await executor.execute({
    model: "gemini-3-flash",
    body: {
      messages: [
        { role: "user", content: "Check system config and status" },
        turn1Choice.message,
        {
          role: "tool",
          tool_call_id: "call_read_1",
          name: "readFile",
          content: '{"status":"ok","env":"prod"}',
        },
        {
          role: "tool",
          tool_call_id: "call_status_2",
          name: "fetchStatus",
          content: '{"healthy":true}',
        },
      ],
      tools,
    },
    stream: false,
    credentials: {
      apiKey: "token-agentic",
      providerSpecificData: { projectId: "proj-agentic" },
    },
    signal: null,
    log: null,
  });

  assert.equal(turn2Result.response.status, 200);
  const turn2Completion = (await turn2Result.response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(
    turn2Completion.choices[0].message.content,
    "Config is valid and auth service is healthy."
  );
});

test("Tier 4 Scenario 4: Parameter-Less Tool Execution with _confirm Workaround", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      request?: {
        tools?: Array<{
          functionDeclarations?: Array<{
            parametersJsonSchema?: {
              properties?: Record<string, unknown>;
            };
          }>;
        }>;
      };
    };
    const funcDecl = body.request?.tools?.[0]?.functionDeclarations?.[0];

    // Verify _confirm was injected in request parametersJsonSchema with type BOOLEAN
    assert.deepEqual(funcDecl?.parametersJsonSchema?.properties?._confirm, {
      type: "BOOLEAN",
      description: "Confirmation flag",
    });

    const sseChunks = [
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "gemini3_getSystemTime",
                      args: { _confirm: true },
                      id: "call_time_e2e",
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      })}\n\n`,
    ].join("");

    return new Response(sseChunks, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const result = await executor.execute({
    model: "gemini-3-flash",
    body: {
      messages: [{ role: "user", content: "What is current time?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "getSystemTime",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
    stream: false,
    credentials: {
      apiKey: "token-e2e",
      providerSpecificData: { projectId: "proj-e2e" },
    },
    signal: null,
    log: null,
  });

  assert.equal(result.response.status, 200);
  const completion = (await result.response.json()) as {
    choices: Array<{
      message: {
        tool_calls: Array<{
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };
  const toolCall = completion.choices[0].message.tool_calls[0];
  assert.equal(toolCall.function.name, "getSystemTime");
  // Injected _confirm must be stripped on response
  assert.equal(toolCall.function.arguments, "{}");
});

test("Tier 4 Scenario 5: 429 Quota Exhaustion, Compound Duration Parsing & Retry-After Extraction", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const executor = new GeminiCliExecutor();

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: "Rate limit exceeded. Your quota will reset after 156h14m36.73s.",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await executor.execute({
    model: "gemini-3-flash",
    body: {
      messages: [{ role: "user", content: "High volume request" }],
    },
    stream: true,
    credentials: {
      apiKey: "token-429",
      providerSpecificData: { projectId: "proj-quota-exhausted" },
    },
    signal: null,
    log: null,
  });

  assert.equal(result.response.status, 429);
  // 156h14m36.73s = 562476.73s -> Math.ceil(562476730 / 1000) = 562477s
  assert.equal(result.response.headers.get("Retry-After"), "562477");

  const errJson = (await result.response.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(errJson.error.code, "rate_limit_exceeded");
  assert.ok(errJson.error.message.includes("156h14m36.73s"));
});
