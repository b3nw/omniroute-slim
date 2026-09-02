import test from "node:test";
import assert from "node:assert/strict";
import {
  CCPA_AI_MODEL_MAPPINGS,
  GEMINI3_TOOL_PREFIX,
  DEFAULT_GEMINI3_SYSTEM_INSTRUCTION,
  DEFAULT_SAFETY_SETTINGS,
  mapModelToGeminiCliWire,
  isGemini3,
  needsThoughtSignature,
  buildGeminiCliClientMetadata,
  generateUserPromptId,
  generateStableSessionId,
  inlineSchemaRefs,
  cleanGeminiCliSchema,
  enforceStrictSchema,
  formatTypeHint,
  injectSignatureIntoDescription,
  transformToolSchemas,
  parseContentParts,
  fixToolResponseGrouping,
  _fix_tool_response_grouping,
  handleReasoningParameters,
  translateToolChoice,
  transformMessages,
  translateChatRequestToGeminiCli,
  type OpenAIChatRequest,
} from "../../open-sse/translator/request/geminiCli.ts";
import {
  FINISH_REASON_MAP,
  stripGemini3Prefix,
  buildUsageBlock,
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
// TIER 1: Model Remapping, Fingerprinting & Request/Response Envelopes
// ============================================================================

test("Tier 1: Wire Model Remapping and Model Helpers", () => {
  assert.equal(mapModelToGeminiCliWire("gemini-3.5-flash"), "gemini-3-flash");
  assert.equal(mapModelToGeminiCliWire("gemini-3.5-flash:thinking"), "gemini-3-flash");
  assert.equal(mapModelToGeminiCliWire("gemini-cli/gemini-3.5-flash"), "gemini-3-flash");
  assert.equal(mapModelToGeminiCliWire("gemini-3-flash"), "gemini-3-flash");
  assert.equal(mapModelToGeminiCliWire("gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(mapModelToGeminiCliWire(""), "gemini-3-flash");

  assert.equal(isGemini3("gemini-3.5-flash"), true);
  assert.equal(isGemini3("gemini-3-flash"), true);
  assert.equal(isGemini3("gemini-3-pro"), true);
  assert.equal(isGemini3("gemini-2.5-pro"), false);
  assert.equal(isGemini3("gemini-1.5-flash"), false);

  assert.equal(needsThoughtSignature("gemini-3.5-flash"), true);
  assert.equal(needsThoughtSignature("gemini-3-flash"), true);
  assert.equal(needsThoughtSignature("gemini-2.5-flash"), true);
  assert.equal(needsThoughtSignature("gemini-1.5-pro"), false);
});

test("Tier 1: Fingerprinting & Client Metadata Generation", () => {
  const promptId1 = generateUserPromptId();
  const promptId2 = generateUserPromptId();
  assert.match(promptId1, /^[0-9a-f]{14}$/);
  assert.match(promptId2, /^[0-9a-f]{14}$/);
  assert.notEqual(promptId1, promptId2);

  const contentsWithAnchors = [
    {
      role: "user",
      parts: [{ text: "This is a sufficiently long anchor text that has more than four words." }],
    },
    {
      role: "model",
      parts: [{ text: "Here is another long anchor text that also has more than four words." }],
    },
  ];

  const sessionId1 = generateStableSessionId(contentsWithAnchors);
  const sessionId2 = generateStableSessionId(contentsWithAnchors);
  assert.match(sessionId1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(
    sessionId1,
    sessionId2,
    "Stable session ID should be deterministic for identical anchors"
  );

  const metadata = buildGeminiCliClientMetadata("test-duet-project-999");
  assert.deepEqual(metadata, {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    duetProject: "test-duet-project-999",
  });
});

test("Tier 1: Message & Multipart Translation into CCPA Contents Envelope", () => {
  const req: OpenAIChatRequest = {
    model: "gemini-3-flash",
    messages: [
      { role: "system", content: "You are an expert fullstack software architect." },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this image diagram:" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "I see a single 1x1 pixel image.",
      },
    ],
  };

  const translated = translateChatRequestToGeminiCli(req, { projectId: "gcp-proj-alpha" });
  assert.equal(translated.urlAction, ":streamGenerateContent?alt=sse");
  assert.equal(translated.wireModel, "gemini-3-flash");
  assert.equal(translated.body.model, "gemini-3-flash");
  assert.equal(translated.body.project, "gcp-proj-alpha");
  assert.match(String(translated.body.user_prompt_id), /^[0-9a-f]{14}$/);

  const requestPayload = translated.body.request as Record<string, unknown>;
  const contents = requestPayload.contents as Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  assert.equal(contents.length, 2);

  assert.equal(contents[0].role, "user");
  assert.equal(contents[0].parts[0].text, "Analyze this image diagram:");
  const inlineData = contents[0].parts[1].inlineData as { mimeType: string; data: string };
  assert.equal(inlineData.mimeType, "image/png");
  assert.ok(inlineData.data.startsWith("iVBORw0KGgo"));

  assert.equal(contents[1].role, "model");
  assert.equal(contents[1].parts[0].text, "I see a single 1x1 pixel image.");

  const sysInstruction = requestPayload.systemInstruction as {
    role: string;
    parts: Array<{ text: string }>;
  };
  assert.equal(sysInstruction.parts[0].text, "You are an expert fullstack software architect.");
});

test("Tier 1: Response Translation - Streaming Chunk Translation", () => {
  const mockUpstreamChunk = {
    response: {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "Let me think through this algorithm." },
              { text: "Here is the completed solution." },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 25,
        totalTokenCount: 165,
        cachedContentTokenCount: 20,
      },
    },
  };

  const chunks = translateGeminiCliChunkToOpenAI(mockUpstreamChunk, "gemini-3.5-flash");
  assert.ok(chunks && chunks.length >= 3);

  // First chunk has reasoning
  assert.equal(chunks[0].model, "gemini-3.5-flash");
  assert.equal(
    (chunks[0].choices as Array<{ delta: { reasoning_content?: string } }>)[0].delta
      .reasoning_content,
    "Let me think through this algorithm."
  );

  // Second chunk has content
  assert.equal(
    (chunks[1].choices as Array<{ delta: { content?: string } }>)[0].delta.content,
    "Here is the completed solution."
  );

  // Third chunk has finish reason stop
  assert.equal((chunks[2].choices as Array<{ finish_reason?: string }>)[0].finish_reason, "stop");
  assert.deepEqual(chunks[2].usage, {
    prompt_tokens: 100,
    completion_tokens: 65,
    total_tokens: 165,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 25 },
  });
});

test("Tier 1: Response Translation - Non-Streaming Full Translation", () => {
  const mockUpstreamResponse = {
    response: {
      candidates: [
        {
          content: {
            parts: [{ thought: true, text: "Thinking step..." }, { text: "Direct response text." }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 15,
        thoughtsTokenCount: 5,
        totalTokenCount: 50,
      },
    },
  };

  const response = translateGeminiCliResponseToOpenAI(mockUpstreamResponse, "gemini-3.5-flash");
  assert.equal(response.model, "gemini-3.5-flash");
  assert.equal(response.object, "chat.completion");
  const choice = (
    response.choices as Array<{
      finish_reason: string;
      message: { content: string; reasoning_content?: string };
    }>
  )[0];
  assert.equal(choice.finish_reason, "stop");
  assert.equal(choice.message.content, "Direct response text.");
  assert.equal(choice.message.reasoning_content, "Thinking step...");
  assert.deepEqual(response.usage, {
    prompt_tokens: 30,
    completion_tokens: 20,
    total_tokens: 50,
    completion_tokens_details: { reasoning_tokens: 5 },
  });
});

test("Tier 1: Chunk Reassembly (reassembleGeminiCliChunks)", () => {
  const chunks = [
    {
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 12345678,
      model: "gemini-3-flash",
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "Thought A. " },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 12345678,
      model: "gemini-3-flash",
      choices: [
        {
          index: 0,
          delta: { content: "Part 1, " },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 12345678,
      model: "gemini-3-flash",
      choices: [
        {
          index: 0,
          delta: { content: "Part 2." },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20,
      },
    },
  ];

  const full = reassembleGeminiCliChunks(chunks, "gemini-3-flash");
  assert.equal(full.id, "chatcmpl-stream-1");
  assert.equal(full.model, "gemini-3-flash");
  const choice = (
    full.choices as Array<{
      message: { content: string; reasoning_content?: string };
      finish_reason: string;
    }>
  )[0];
  assert.equal(choice.message.content, "Part 1, Part 2.");
  assert.equal(choice.message.reasoning_content, "Thought A. ");
  assert.equal(choice.finish_reason, "stop");
  assert.deepEqual(full.usage, {
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
  });
});

// ============================================================================
// TIER 2: Schemas, Tool Calling, Parallel Responses & Thought Signatures
// ============================================================================

test("Tier 2: Schema Ref Inlining, Cleaning & Strict Schema Enforcement", () => {
  const rawSchema = {
    type: "object",
    $defs: {
      Coordinates: {
        type: "object",
        properties: {
          lat: { type: ["number", "null"] },
          lng: { type: "number" },
        },
        required: ["lat", "lng"],
      },
    },
    properties: {
      location: { $ref: "#/$defs/Coordinates" },
    },
    strict: true,
    $schema: "http://json-schema.org/draft-07/schema#",
  };

  const inlined = inlineSchemaRefs(rawSchema) as {
    properties: {
      location: { type: string; properties: { lng: { type: string } }; $ref?: string };
    };
  };
  assert.equal(inlined.properties.location.type, "object");
  assert.equal(inlined.properties.location.properties.lng.type, "number");
  assert.equal(inlined.properties.location.$ref, undefined);

  const cleaned = cleanGeminiCliSchema(inlined) as {
    $defs?: unknown;
    $schema?: unknown;
    strict?: unknown;
    properties: { location: { properties: { lat: { type: string; nullable?: boolean } } } };
  };
  assert.equal(cleaned.$defs, undefined);
  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.strict, undefined);
  assert.equal(cleaned.properties.location.properties.lat.type, "number");
  assert.equal(cleaned.properties.location.properties.lat.nullable, true);

  const strict = enforceStrictSchema(cleaned) as {
    additionalProperties: boolean;
    properties: { location: { additionalProperties: boolean } };
  };
  assert.equal(strict.additionalProperties, false);
  assert.equal(strict.properties.location.additionalProperties, false);
});

test("Tier 2: Tool Transformation, gemini3_ Prefix & _confirm BOOLEAN Injection", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "queryDatabase",
        description: "Runs a SQL query",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "The SQL statement" },
          },
          required: ["sql"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getSystemInfo",
        description: "Returns system hardware info",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
  ];

  const transformed = transformToolSchemas(tools, "gemini-3-flash");
  assert.equal(transformed.length, 2);

  // Gemini 3 tools get prefix gemini3_ and strict parameters hint injected into description
  assert.equal(transformed[0].name, "gemini3_queryDatabase");
  assert.ok(
    String(transformed[0].description).includes("STRICT PARAMETERS"),
    "Should inject parameter hints into description for Gemini 3"
  );
  const schema0 = transformed[0].parametersJsonSchema as { additionalProperties?: boolean };
  assert.equal(schema0.additionalProperties, false);

  // Parameterless tool receives _confirm with type "BOOLEAN"
  assert.equal(transformed[1].name, "gemini3_getSystemInfo");
  const schema1 = transformed[1].parametersJsonSchema as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.equal(schema1.type, "OBJECT");
  assert.deepEqual(schema1.properties?._confirm, {
    type: "BOOLEAN",
    description: "Confirmation flag",
  });
  assert.deepEqual(schema1.required, ["_confirm"]);
});

test("Tier 2: Response Translation Strips Injected _confirm Argument", () => {
  const mockChunkWithConfirm = {
    response: {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "gemini3_getSystemInfo",
                  args: { _confirm: true },
                  id: "call_sys_info_1",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
  };

  const chunks = translateGeminiCliChunkToOpenAI(mockChunkWithConfirm, "gemini-3-flash");
  assert.ok(chunks);
  const toolCallChunk = chunks[0];
  const toolCall = (
    toolCallChunk.choices as Array<{
      delta: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
    }>
  )[0].delta.tool_calls[0];
  assert.equal(toolCall.function.name, "getSystemInfo");
  assert.equal(toolCall.function.arguments, "{}"); // _confirm stripped

  // Non-streaming path
  const fullResp = translateGeminiCliResponseToOpenAI(mockChunkWithConfirm, "gemini-3-flash");
  const messageToolCall = (
    fullResp.choices as Array<{
      message: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
    }>
  )[0].message.tool_calls[0];
  assert.equal(messageToolCall.function.name, "getSystemInfo");
  assert.equal(messageToolCall.function.arguments, "{}");
});

test("Tier 2: Parallel Tool Response Auto-Repair (fixToolResponseGrouping)", () => {
  const inputContents = [
    {
      role: "user",
      parts: [{ text: "Fetch exchange rates for EUR and JPY" }],
    },
    {
      role: "model",
      parts: [
        {
          functionCall: {
            name: "get_rate",
            args: { currency: "EUR" },
            id: "call_rate_eur",
          },
        },
        {
          functionCall: {
            name: "get_rate",
            args: { currency: "JPY" },
            id: "call_rate_jpy",
          },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "get_rate",
            response: { result: { rate: 1.08 } },
            id: "call_rate_eur",
          },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "get_rate",
            response: { result: { rate: 155.2 } },
            id: "call_rate_jpy",
          },
        },
      ],
    },
  ];

  const grouped = fixToolResponseGrouping(inputContents);
  assert.equal(grouped.length, 3, "Both functionResponses must be aggregated into one user turn");
  assert.equal(grouped[0].role, "user");
  assert.equal(grouped[1].role, "model");
  assert.equal(grouped[2].role, "user");
  assert.equal(grouped[2].parts.length, 2);
  assert.equal((grouped[2].parts[0].functionResponse as { id?: string }).id, "call_rate_eur");
  assert.equal((grouped[2].parts[1].functionResponse as { id?: string }).id, "call_rate_jpy");
});

test("Tier 2: Thought Signature Caching & Single-Signature Cardinality", () => {
  clearGeminiThoughtSignatureMemoryForTests();
  storeGeminiThoughtSignature("call_primary", "sig_verified_primary_123");

  const req: OpenAIChatRequest = {
    model: "gemini-3-flash",
    messages: [
      { role: "user", content: "Execute batch operations" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_primary",
            type: "function",
            function: { name: "operationA", arguments: "{}" },
          },
          {
            id: "call_secondary",
            type: "function",
            function: { name: "operationB", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_primary",
        name: "operationA",
        content: '{"status":"ok"}',
      },
      {
        role: "tool",
        tool_call_id: "call_secondary",
        name: "operationB",
        content: '{"status":"ok"}',
      },
    ],
  };

  const translated = translateChatRequestToGeminiCli(req, { projectId: "test-proj" });
  const contents = (
    translated.body.request as {
      contents: Array<{
        role: string;
        parts: Array<{ thoughtSignature?: string }>;
      }>;
    }
  ).contents;

  // Find the assistant (model) turn
  const modelTurn = contents.find((c) => c.role === "model");
  assert.ok(modelTurn);
  assert.equal(modelTurn.parts.length, 2);

  // First parallel tool call receives thoughtSignature from store
  assert.equal(modelTurn.parts[0].thoughtSignature, "sig_verified_primary_123");
  // Second parallel tool call in same turn must NOT have thoughtSignature
  assert.equal(modelTurn.parts[1].thoughtSignature, undefined);
});

// ============================================================================
// TIER 3: Reasoning Parameters & Combinatorial Matrix
// ============================================================================

test("Tier 3: Reasoning Parameter Mapping for Gemini 2.5 vs Gemini 3", () => {
  // Gemini 3 Flash maps to thinkingLevel
  const gem3FlashMinimal = handleReasoningParameters(
    { reasoning_effort: "none" },
    "gemini-3-flash"
  );
  assert.deepEqual(gem3FlashMinimal, {
    thinkingLevel: "minimal",
    include_thoughts: true,
  });

  const gem3FlashLow = handleReasoningParameters({ reasoning_effort: "low" }, "gemini-3-flash");
  assert.deepEqual(gem3FlashLow, {
    thinkingLevel: "low",
    include_thoughts: true,
  });

  const gem3FlashHigh = handleReasoningParameters({ reasoning_effort: "high" }, "gemini-3-flash");
  assert.deepEqual(gem3FlashHigh, {
    thinkingLevel: "high",
    include_thoughts: true,
  });

  // Gemini 2.5 maps to thinkingBudget
  const gem25None = handleReasoningParameters({ reasoning_effort: "none" }, "gemini-2.5-flash");
  assert.deepEqual(gem25None, {
    thinkingBudget: 0,
    include_thoughts: false,
  });

  const gem25Low = handleReasoningParameters({ reasoning_effort: "low" }, "gemini-2.5-flash");
  assert.deepEqual(gem25Low, {
    thinkingBudget: 6144,
    include_thoughts: true,
  });

  const gem25High = handleReasoningParameters({ reasoning_effort: "high" }, "gemini-2.5-flash");
  assert.deepEqual(gem25High, {
    thinkingBudget: 24576,
    include_thoughts: true,
  });
});

test("Tier 3: Combinatorial Matrix Across Models, Tools and Reasoning Configurations", () => {
  const models = ["gemini-3.5-flash", "gemini-3-flash", "gemini-2.5-pro"];
  const reasoningEfforts = ["none", "low", "high"];
  const toolOptions = [
    undefined,
    [
      {
        type: "function" as const,
        function: {
          name: "calculateSum",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      },
    ],
  ];

  for (const model of models) {
    for (const effort of reasoningEfforts) {
      for (const tools of toolOptions) {
        const req: OpenAIChatRequest = {
          model,
          reasoning_effort: effort,
          messages: [{ role: "user", content: "Combinatorial test prompt" }],
          tools: tools,
        };

        const translated = translateChatRequestToGeminiCli(req, { projectId: "matrix-proj" });
        assert.ok(translated.body.model);
        assert.ok(translated.body.user_prompt_id);

        const reqObj = translated.body.request as {
          generationConfig: {
            thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number };
          };
          systemInstruction?: { parts: Array<{ text: string }> };
          tools?: Array<{ functionDeclarations: Array<{ name: string }> }>;
        };
        const genConfig = reqObj.generationConfig;

        if (isGemini3(model)) {
          assert.equal(translated.body.model, "gemini-3-flash");
          assert.ok(genConfig.thinkingConfig?.thinkingLevel);
          if (tools && tools.length > 0) {
            assert.ok(
              reqObj.systemInstruction?.parts[0].text.includes("CRITICAL_TOOL_USAGE_INSTRUCTIONS")
            );
            assert.ok(reqObj.tools?.[0].functionDeclarations[0].name.startsWith("gemini3_"));
          }
        } else {
          assert.equal(translated.body.model, "gemini-2.5-pro");
          assert.notEqual(genConfig.thinkingConfig?.thinkingBudget, undefined);
        }
      }
    }
  }
});
