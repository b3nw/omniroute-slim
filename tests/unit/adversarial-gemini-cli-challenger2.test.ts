import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  inlineSchemaRefs,
  cleanGeminiCliSchema,
  enforceStrictSchema,
  transformToolSchemas,
  fixToolResponseGrouping,
  _fix_tool_response_grouping,
  transformMessages,
  translateChatRequestToGeminiCli,
  mapModelToGeminiCliWire,
  isGemini3,
  needsThoughtSignature,
  generateUserPromptId,
  generateStableSessionId,
  handleReasoningParameters,
} from "../../open-sse/translator/request/geminiCli.ts";
import {
  translateGeminiCliChunkToOpenAI,
  translateGeminiCliResponseToOpenAI,
  reassembleGeminiCliChunks,
  stripGemini3Prefix,
  buildUsageBlock,
} from "../../open-sse/translator/response/geminiCli.ts";
import {
  GeminiCliExecutor,
  buildGeminiCliHeaders,
  parseGeminiCliResetDuration,
  sanitizeGeminiCliError,
  GEMINI_CLI_ENDPOINT_FALLBACKS,
} from "../../open-sse/executors/geminiCli.ts";
import {
  storeGeminiThoughtSignature,
  getGeminiThoughtSignature,
  clearGeminiThoughtSignatures,
  clearGeminiThoughtSignatureMemoryForTests,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import {
  parseRetryFromErrorText,
  classifyErrorText,
} from "../../open-sse/services/accountFallback.ts";
import { sanitizeErrorMessage, buildErrorBody } from "../../open-sse/utils/error.ts";

// ============================================================================
// CHALLENGE 1: Schema Inlining Stress
// ============================================================================

test("Challenge 1.1: Deeply nested JSON schemas with local definitions ($defs and definitions)", () => {
  const schemaWithNestedDefs = {
    type: "object",
    $defs: {
      Country: {
        type: "object",
        properties: {
          code: { type: "string" },
          name: { type: "string" },
        },
        required: ["code"],
      },
      Address: {
        type: "object",
        properties: {
          street: { type: ["string", "null"] },
          country: { $ref: "#/$defs/Country" },
        },
        required: ["street", "country"],
      },
      UserProfile: {
        type: "object",
        properties: {
          id: { type: "string" },
          address: { $ref: "#/$defs/Address" },
        },
      },
    },
    properties: {
      profile: { $ref: "#/$defs/UserProfile" },
    },
  };

  const inlined = inlineSchemaRefs(schemaWithNestedDefs) as Record<string, unknown>;
  const cleaned = cleanGeminiCliSchema(inlined) as Record<string, unknown>;

  // $defs must be stripped
  assert.equal(cleaned.$defs, undefined);

  // Deeply nested properties must be completely resolved
  const props = cleaned.properties as Record<
    string,
    {
      type?: string;
      properties?: Record<
        string,
        {
          type?: string;
          nullable?: boolean;
          properties?: Record<
            string,
            {
              type?: string;
              properties?: Record<
                string,
                {
                  type?: string;
                  required?: string[];
                }
              >;
              required?: string[];
            }
          >;
        }
      >;
    }
  >;
  assert.ok(props.profile);
  assert.equal(props.profile.type, "object");
  assert.ok(props.profile.properties?.id);
  assert.ok(props.profile.properties?.address);
  assert.equal(props.profile.properties?.address.type, "object");
  assert.ok(props.profile.properties?.address.properties?.country);
  assert.equal(props.profile.properties?.address.properties?.country.type, "object");
  assert.equal(
    props.profile.properties?.address.properties?.country.properties?.code.type,
    "string"
  );
  assert.deepEqual(props.profile.properties?.address.properties?.country.required, ["code"]);

  // Union type ["string", "null"] in Address.street must be normalized
  assert.equal(props.profile.properties?.address.properties?.street.type, "string");
  assert.equal(props.profile.properties?.address.properties?.street.nullable, true);
});

test("Challenge 1.2: Circular $ref cycle resolution does not overflow and strips cyclical refs", () => {
  const circularSchema = {
    type: "object",
    definitions: {
      Person: {
        type: "object",
        properties: {
          name: { type: "string" },
          manager: { $ref: "#/definitions/Person" },
        },
      },
    },
    properties: {
      employee: { $ref: "#/definitions/Person" },
    },
  };

  // Must not throw StackOverflow
  const inlined = inlineSchemaRefs(circularSchema) as {
    properties: {
      employee: { properties: { name: { type: string }; manager: { $ref?: string } } };
    };
  };
  const cleaned = cleanGeminiCliSchema(inlined) as {
    definitions?: unknown;
    properties: {
      employee: { properties: { name: { type: string }; manager: { $ref?: string } } };
    };
  };

  assert.equal(cleaned.definitions, undefined);
  assert.ok(cleaned.properties.employee);
  assert.equal(cleaned.properties.employee.properties.name.type, "string");
  // Circular ref cycle is broken and $ref removed
  assert.equal(cleaned.properties.employee.properties.manager.$ref, undefined);
});

test("Challenge 1.3: Union types normalization (all scalar types with null)", () => {
  const unionSchema = {
    type: "object",
    properties: {
      str: { type: ["string", "null"] },
      num: { type: ["number", "null"] },
      int: { type: ["integer", "null"] },
      bool: { type: ["boolean", "null"] },
      obj: { type: ["object", "null"] },
      arr: { type: ["array", "null"], items: { type: "string" } },
      singleArr: { type: ["string"] },
    },
  };

  const cleaned = cleanGeminiCliSchema(unionSchema) as {
    properties: Record<string, { type: string; nullable?: boolean }>;
  };
  assert.equal(cleaned.properties.str.type, "string");
  assert.equal(cleaned.properties.str.nullable, true);
  assert.equal(cleaned.properties.num.type, "number");
  assert.equal(cleaned.properties.num.nullable, true);
  assert.equal(cleaned.properties.int.type, "integer");
  assert.equal(cleaned.properties.int.nullable, true);
  assert.equal(cleaned.properties.bool.type, "boolean");
  assert.equal(cleaned.properties.bool.nullable, true);
  assert.equal(cleaned.properties.obj.type, "object");
  assert.equal(cleaned.properties.obj.nullable, true);
  assert.equal(cleaned.properties.arr.type, "array");
  assert.equal(cleaned.properties.arr.nullable, true);
  assert.equal(cleaned.properties.singleArr.type, "string");
});

test("Challenge 1.4: Empty properties objects injected with _confirm parameter and cleanly stripped on response", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "getSystemStatus",
        description: "Fetch live system status",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ping",
        description: "Ping service",
        parameters: {
          type: "object",
        },
      },
    },
  ];

  const transformedTools = transformToolSchemas(tools, "gemini-3-flash");
  assert.equal(transformedTools.length, 2);

  // Tool 1: getSystemStatus
  const t1 = transformedTools[0];
  assert.equal(t1.name, "gemini3_getSystemStatus");
  const t1Schema = t1.parametersJsonSchema as {
    type: string;
    properties: Record<string, { type: string }>;
    required?: string[];
  };
  assert.equal(t1Schema.type, "OBJECT");
  assert.ok(t1Schema.properties._confirm);
  assert.equal(t1Schema.properties._confirm.type, "BOOLEAN");
  assert.deepEqual(t1Schema.required, ["_confirm"]);

  // Tool 2: ping
  const t2 = transformedTools[1];
  assert.equal(t2.name, "gemini3_ping");
  const t2Schema = t2.parametersJsonSchema as {
    type: string;
    properties: Record<string, { type: string }>;
    required?: string[];
  };
  assert.equal(t2Schema.type, "OBJECT");
  assert.ok(t2Schema.properties._confirm);
  assert.equal(t2Schema.properties._confirm.type, "BOOLEAN");
  assert.deepEqual(t2Schema.required, ["_confirm"]);

  // Verify response translation strips _confirm cleanly from streaming chunks
  const mockChunk = {
    response: {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "gemini3_getSystemStatus",
                  args: { _confirm: true },
                  id: "call_status_001",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
  };

  const chunks = translateGeminiCliChunkToOpenAI(mockChunk, "gemini-3-flash");
  assert.ok(chunks);
  const toolCall = chunks[0].choices[0].delta.tool_calls?.[0];
  assert.ok(toolCall);
  assert.equal(toolCall.function.name, "getSystemStatus");
  assert.equal(toolCall.function.arguments, "{}"); // _confirm stripped!

  // Verify non-streaming response translation also strips _confirm
  const nonStreamResp = translateGeminiCliResponseToOpenAI(mockChunk, "gemini-3-flash");
  const nonStreamCall = nonStreamResp.choices[0].message.tool_calls?.[0];
  assert.ok(nonStreamCall);
  assert.equal(nonStreamCall.function.name, "getSystemStatus");
  assert.equal(nonStreamCall.function.arguments, "{}"); // _confirm stripped!
});

// ============================================================================
// CHALLENGE 2: Parallel Tool Responses Auto-Repair
// ============================================================================

test("Challenge 2.1: Consolidates 3 parallel tool responses into 1 user turn with 3 functionResponse parts", () => {
  const rawContents = [
    {
      role: "user",
      parts: [{ text: "Fetch data from file A, file B, and file C" }],
    },
    {
      role: "model",
      parts: [
        { functionCall: { name: "readFile", id: "call_a", args: { file: "a.txt" } } },
        { functionCall: { name: "readFile", id: "call_b", args: { file: "b.txt" } } },
        { functionCall: { name: "readFile", id: "call_c", args: { file: "c.txt" } } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "readFile", id: "call_a", response: { result: "content A" } } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "readFile", id: "call_b", response: { result: "content B" } } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "readFile", id: "call_c", response: { result: "content C" } } },
      ],
    },
  ];

  const fixed = fixToolResponseGrouping(rawContents);
  assert.equal(fixed.length, 3); // user initial, model (3 calls), user (3 responses grouped)
  assert.equal(fixed[0].role, "user");
  assert.equal(fixed[1].role, "model");
  assert.equal(fixed[2].role, "user");

  const responseParts = fixed[2].parts as Array<{
    functionResponse: { id: string; response: { result: string } };
  }>;
  assert.equal(responseParts.length, 3);
  assert.equal(responseParts[0].functionResponse.id, "call_a");
  assert.equal(responseParts[0].functionResponse.response.result, "content A");
  assert.equal(responseParts[1].functionResponse.id, "call_b");
  assert.equal(responseParts[1].functionResponse.response.result, "content B");
  assert.equal(responseParts[2].functionResponse.id, "call_c");
  assert.equal(responseParts[2].functionResponse.response.result, "content C");
});

test("Challenge 2.2: Full chat translation auto-repairs parallel tool response messages from OpenAI format", () => {
  const request = {
    model: "gemini-3-flash",
    messages: [
      { role: "user", content: "Run batch tasks" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_t1", type: "function", function: { name: "task1", arguments: "{}" } },
          { id: "call_t2", type: "function", function: { name: "task2", arguments: "{}" } },
          { id: "call_t3", type: "function", function: { name: "task3", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_t1", name: "task1", content: '{"ok":1}' },
      { role: "tool", tool_call_id: "call_t2", name: "task2", content: '{"ok":2}' },
      { role: "tool", tool_call_id: "call_t3", name: "task3", content: '{"ok":3}' },
    ],
  };

  const translated = translateChatRequestToGeminiCli(request, { projectId: "test-proj" });
  const contents = translated.body.request.contents as Array<{
    role: string;
    parts: Array<{ functionResponse?: { id?: string } }>;
  }>;

  assert.equal(contents.length, 3);
  assert.equal(contents[0].role, "user");
  assert.equal(contents[1].role, "model");
  assert.equal(contents[1].parts.length, 3);
  assert.equal(contents[2].role, "user");
  assert.equal(contents[2].parts.length, 3);

  // Function responses must map correctly to tool calls
  assert.equal(contents[2].parts[0].functionResponse?.id, "call_t1");
  assert.equal(contents[2].parts[1].functionResponse?.id, "call_t2");
  assert.equal(contents[2].parts[2].functionResponse?.id, "call_t3");
});

// ============================================================================
// CHALLENGE 3: Thought Signature Integrity
// ============================================================================

test("Challenge 3.1: Single-signature rule on parallel tool turns (only 1st function call gets signature)", () => {
  clearGeminiThoughtSignatures();

  const messages = [
    { role: "user", content: "Run multiple tools in parallel" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_fresh_sig_1", type: "function", function: { name: "toolA", arguments: "{}" } },
        { id: "call_fresh_sig_2", type: "function", function: { name: "toolB", arguments: "{}" } },
        { id: "call_fresh_sig_3", type: "function", function: { name: "toolC", arguments: "{}" } },
      ],
    },
  ];

  const { contents } = transformMessages(messages, "gemini-3-flash");
  const modelMsg = contents.find((c) => c.role === "model");
  assert.ok(modelMsg);
  assert.equal(modelMsg.parts.length, 3);

  // 1st tool call must receive the thoughtSignature (skip validator fallback if not in cache)
  assert.equal(modelMsg.parts[0].thoughtSignature, "skip_thought_signature_validator");

  // 2nd and 3rd tool calls MUST NOT receive thoughtSignature
  assert.equal(modelMsg.parts[1].thoughtSignature, undefined);
  assert.equal(modelMsg.parts[2].thoughtSignature, undefined);
});

test("Challenge 3.2: Thought signature caching, storage, and re-injection across multi-turn conversation", () => {
  clearGeminiThoughtSignatureMemoryForTests();

  // 1. Store signature from an upstream response
  const callId = "call_auth_check_88";
  const validSig = "R0IAAAAAAAAYASAC";
  storeGeminiThoughtSignature(callId, validSig);
  assert.equal(getGeminiThoughtSignature(callId), validSig);

  // 2. Translate a request referencing this tool call
  const messages = [
    { role: "user", content: "Check authorization" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: callId, type: "function", function: { name: "authCheck", arguments: "{}" } },
        { id: "call_aux_99", type: "function", function: { name: "logEvent", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: callId, name: "authCheck", content: '{"authorized":true}' },
    { role: "tool", tool_call_id: "call_aux_99", name: "logEvent", content: '{"logged":true}' },
  ];

  const { contents } = transformMessages(messages, "gemini-3-flash");
  const modelMsg = contents.find((c) => c.role === "model");
  assert.ok(modelMsg);

  // 1st function call gets the cached signature
  assert.equal(modelMsg.parts[0].thoughtSignature, validSig);
  // 2nd function call does NOT get a signature
  assert.equal(modelMsg.parts[1].thoughtSignature, undefined);
});

test("Challenge 3.3: Thought signature store survives multi-turn parallel calls", () => {
  storeGeminiThoughtSignature("call_parallel_1", "sig_alpha_999");
  storeGeminiThoughtSignature("call_parallel_2", "sig_beta_888");

  assert.equal(getGeminiThoughtSignature("call_parallel_1"), "sig_alpha_999");
  assert.equal(getGeminiThoughtSignature("call_parallel_2"), "sig_beta_888");
  assert.equal(getGeminiThoughtSignature("call_unknown"), null);
});

test("Challenge 3.4: Missing thought signature injects synthetic valid SHA256-prefixed dummy signature", () => {
  const request = {
    model: "gemini-3-flash",
    messages: [
      { role: "user", content: "Initial query" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_missing_sig_xyz",
            type: "function",
            function: { name: "doTask", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_missing_sig_xyz",
        name: "doTask",
        content: '{"result":"success"}',
      },
    ],
  };

  const translated = translateChatRequestToGeminiCli(request, { projectId: "test-proj" });
  const modelPart = (
    translated.body.request.contents as Array<{
      role: string;
      parts: Array<{ thoughtSignature?: string }>;
    }>
  )[1].parts[0];
  assert.ok(modelPart.thoughtSignature);
  assert.ok(modelPart.thoughtSignature.length > 10);
});

// ============================================================================
// CHALLENGE 4: Failover, Timeout & Error Sanitization Rigor
// ============================================================================

test("Challenge 4.1: Multi-endpoint fallback chains smoothly on 503 Service Unavailable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calledUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calledUrls.push(url);

    if (url.startsWith("https://cloudcode-pa.googleapis.com")) {
      return new Response(
        JSON.stringify({
          error: { code: 503, message: "Primary service overloaded", status: "UNAVAILABLE" },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    // Secondary fallback endpoint succeeds with SSE format
    const sseText = [
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: "Fallback to secondary succeeded!" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, totalTokenCount: 25 },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    return new Response(sseText, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const executor = new GeminiCliExecutor();
  const result = await executor.execute({
    model: "gemini-3-flash",
    body: {
      messages: [{ role: "user", content: "Test endpoint failover" }],
    },
    stream: false,
    credentials: {
      accessToken: "ya29.test_token",
      projectId: "my-gcp-project",
    },
  });

  assert.equal(result.response.status, 200);
  assert.equal(calledUrls.length, 2);
  assert.ok(calledUrls[0].includes("cloudcode-pa.googleapis.com"));
  assert.ok(calledUrls[1].includes("daily-cloudcode-pa.googleapis.com"));

  const jsonBody = (await result.response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(jsonBody.choices[0].message.content, "Fallback to secondary succeeded!");
});

test("Challenge 4.2: Upstream 429 Rate Limit DOES NOT trigger endpoint fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calledUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calledUrls.push(url);

    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          message:
            "You have exhausted your capacity on this model. Your quota will reset after 2s.",
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const executor = new GeminiCliExecutor();
  const result = await executor.execute({
    model: "gemini-3-flash",
    body: {
      messages: [{ role: "user", content: "Test rate limit" }],
    },
    stream: false,
    credentials: {
      accessToken: "ya29.test_token",
      projectId: "my-gcp-project",
    },
  });

  assert.equal(result.response.status, 429);
  // Must stop at primary endpoint (1 request only) and NOT attempt secondary endpoint
  assert.equal(calledUrls.length, 1);
  assert.ok(calledUrls[0].includes("cloudcode-pa.googleapis.com"));

  // Check Retry-After header
  assert.equal(result.response.headers.get("Retry-After"), "2");
});

// ============================================================================
// CHALLENGE 5: Compound 429 Reset Duration Parsing
// ============================================================================

test("Challenge 5.1: Parse compound strings and verify cooldown calculations", () => {
  // 156h14m36s -> 156 * 3600 + 14 * 60 + 36 = 561600 + 840 + 36 = 562476s -> 562,476,000 ms
  assert.equal(parseGeminiCliResetDuration("156h14m36s"), 562476000);
  assert.equal(parseRetryFromErrorText("156h14m36s"), 562476000);

  // 42m10s -> 42 * 60 + 10 = 2520 + 10 = 2530s -> 2,530,000 ms
  assert.equal(parseGeminiCliResetDuration("42m10s"), 2530000);
  assert.equal(parseRetryFromErrorText("42m10s"), 2530000);

  // 15s -> 15,000 ms
  assert.equal(parseGeminiCliResetDuration("15s"), 15000);
  assert.equal(parseRetryFromErrorText("15s"), 15000);

  // 515092.73s -> 515,092,730 ms
  assert.equal(parseGeminiCliResetDuration("515092.73s"), 515092730);
  assert.equal(parseRetryFromErrorText("515092.73s"), 515092730);

  // "Your quota will reset after 2s." -> 2,000 ms
  assert.equal(parseGeminiCliResetDuration("Your quota will reset after 2s."), 2000);
  assert.equal(parseRetryFromErrorText("Your quota will reset after 2s."), 2000);

  // "Rate limit exceeded. Your quota will reset after 156h14m36.73s." -> 562,476,730 ms
  assert.equal(
    parseGeminiCliResetDuration("Rate limit exceeded. Your quota will reset after 156h14m36.73s."),
    562476730
  );
  assert.equal(
    parseRetryFromErrorText("Rate limit exceeded. Your quota will reset after 156h14m36.73s."),
    562476730
  );

  // Google RPC quotaResetDelay
  assert.equal(
    parseRetryFromErrorText('{"error": {"details": [{"quotaResetDelay": "515092.73s"}]}}'),
    515092730
  );
});

// ============================================================================
// CHALLENGE 6: Error Sanitization (CWE-209 & ERROR_SANITIZATION.md)
// ============================================================================

test("Challenge 6.1: Responses never contain stack traces ('at /'), internal file paths, or bearer tokens", () => {
  const toxicErrorMessage = [
    "Error: Upstream request failed with status 500 for token Bearer ya29.a0AfH6SMD_secret123 and secret GOCSPX-secret_xyz",
    "    at Object.execute (/home/b3nw/projects/core/llm-proxy/OmniRoute/open-sse/executors/geminiCli.ts:145:12)",
    "    at async handleChatCore (/home/b3nw/projects/core/llm-proxy/OmniRoute/open-sse/handlers/chatCore.ts:89:9)",
    "    at async /app/dist/server.js:42:1",
  ].join("\n");

  const sanitized = sanitizeGeminiCliError(toxicErrorMessage);
  const generalSanitized = sanitizeErrorMessage(toxicErrorMessage);

  for (const msg of [sanitized, generalSanitized]) {
    // 1. Must not contain stack trace markers
    assert.ok(!msg.includes("at Object.execute"));
    assert.ok(!msg.includes("at async"));
    assert.ok(!msg.includes("at /"));

    // 2. Must not contain internal absolute paths
    assert.ok(!msg.includes("/home/b3nw"));
    assert.ok(!msg.includes("/open-sse/"));
    assert.ok(!msg.includes("/app/dist/"));

    // 3. Must not leak bearer tokens or OAuth secrets
    assert.ok(!msg.includes("ya29.a0AfH6SMD_secret123"));
    assert.ok(!msg.includes("GOCSPX-secret_xyz"));
  }

  // Verify buildErrorBody output
  const errorBody = buildErrorBody(500, toxicErrorMessage, {
    internal_path: "/home/b3nw/sensitive/key.json",
    token: "ya29.v0_secret_token",
    safe_info: "Service temporarily unavailable",
  });

  assert.ok(!errorBody.error.message.includes("/home/b3nw"));
  assert.ok(!errorBody.error.message.includes("at /"));
  assert.ok(!errorBody.error.message.includes("ya29.a0AfH6SMD_secret123"));

  // Check upstream details sanitized
  if (errorBody.upstream_details) {
    const detailsStr = JSON.stringify(errorBody.upstream_details);
    assert.ok(!detailsStr.includes("/home/b3nw"));
    assert.ok(!detailsStr.includes("ya29.v0_secret_token"));
  }
});
