import test from "node:test";
import assert from "node:assert/strict";
import {
  CCPA_AI_MODEL_MAPPINGS,
  GEMINI_CLI_CAPACITY_FALLBACKS,
  getGeminiCliCapacityFallbackModel,
  sanitizeGeminiCliProjectId,
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
  ensureTerminalUserTurn,
  CONTINUE_PROMPT_TEXT,
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
import {
  GEMINI_CLI_SYSTEM_PREAMBLE,
  PROVIDER_GEMINI_CLI,
  DEFAULT_GEMINI_CLI_PIPELINE,
  setSystemTransformsConfig,
  resetSystemTransformsConfig,
} from "../../open-sse/services/systemTransforms.ts";

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

test("Tier 1: Capacity fallback mapping for gemini-3.8-flash", () => {
  assert.equal(GEMINI_CLI_CAPACITY_FALLBACKS["gemini-3.8-flash"], "gemini-3-flash");
  // Not a wire remap: gemini-3.8-flash is sent as-is on the first attempt.
  assert.equal(CCPA_AI_MODEL_MAPPINGS["gemini-3.8-flash"], undefined);
  assert.equal(mapModelToGeminiCliWire("gemini-3.8-flash"), "gemini-3.8-flash");

  assert.equal(getGeminiCliCapacityFallbackModel("gemini-3.8-flash"), "gemini-3-flash");
  assert.equal(getGeminiCliCapacityFallbackModel("gemini-cli/gemini-3.8-flash"), "gemini-3-flash");
  assert.equal(getGeminiCliCapacityFallbackModel("gemini-3.8-flash:thinking"), "gemini-3-flash");
  assert.equal(getGeminiCliCapacityFallbackModel("gemini-3-flash"), null);
  assert.equal(getGeminiCliCapacityFallbackModel("gemini-2.5-pro"), null);
});

test("Tier 1: project is omitted when missing, empty or 'default'", () => {
  assert.equal(sanitizeGeminiCliProjectId("default"), undefined);
  assert.equal(sanitizeGeminiCliProjectId(""), undefined);
  assert.equal(sanitizeGeminiCliProjectId("   "), undefined);
  assert.equal(sanitizeGeminiCliProjectId(undefined), undefined);
  assert.equal(sanitizeGeminiCliProjectId(42), undefined);
  assert.equal(sanitizeGeminiCliProjectId(" gcp-proj "), "gcp-proj");

  const req = { model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] };
  for (const connection of [{ projectId: "default" }, { projectId: "" }, {}, null, undefined]) {
    const translated = translateChatRequestToGeminiCli(req, connection);
    assert.equal("project" in translated.body, false);
    assert.equal(translated.body.model, "gemini-3.8-flash");
  }

  const withProject = translateChatRequestToGeminiCli(req, { projectId: "gcp-proj-beta" });
  assert.equal(withProject.body.project, "gcp-proj-beta");
});

test("Tier 1: Fingerprinting & Client Metadata Generation", () => {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const promptId1 = generateUserPromptId();
  const promptId2 = generateUserPromptId();
  assert.match(promptId1, uuidV4Regex);
  assert.match(promptId2, uuidV4Regex);
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
  assert.match(sessionId1, uuidV4Regex);
  assert.equal(
    sessionId1,
    sessionId2,
    "Stable session ID should be deterministic for identical anchors"
  );
  assert.equal(
    generateUserPromptId(sessionId1),
    sessionId1,
    "generateUserPromptId(sessionId) must equal sessionId"
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
  assert.match(
    String(translated.body.user_prompt_id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  const requestPayload = translated.body.request as Record<string, unknown>;
  assert.equal(translated.body.user_prompt_id, requestPayload.session_id);
  const contents = requestPayload.contents as Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  assert.equal(contents.length, 3);

  assert.equal(contents[0].role, "user");
  assert.equal(contents[0].parts[0].text, "Analyze this image diagram:");
  const inlineData = contents[0].parts[1].inlineData as { mimeType: string; data: string };
  assert.equal(inlineData.mimeType, "image/png");
  assert.ok(inlineData.data.startsWith("iVBORw0KGgo"));

  assert.equal(contents[1].role, "model");
  assert.equal(contents[1].parts[0].text, "I see a single 1x1 pixel image.");

  // Terminal turn is normalized to a user turn carrying content (ensureTerminalUserTurn)
  assert.equal(contents[2].role, "user");
  assert.equal(contents[2].parts[0].text, "Please continue.");

  const sysInstruction = requestPayload.systemInstruction as {
    role: string;
    parts: Array<{ text: string }>;
  };
  assert.equal(
    sysInstruction.parts[0].text,
    `${GEMINI_CLI_SYSTEM_PREAMBLE}\n\nYou are an expert fullstack software architect.`
  );
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

test("Tier 2: Tool Transformation Preserves Clean Tool Names & Descriptions + _confirm BOOLEAN Injection", () => {
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

  // Clean tool names and clean descriptions by default (no gemini3_ prefix, no STRICT PARAMETERS)
  assert.equal(transformed[0].name, "queryDatabase");
  assert.equal(transformed[0].description, "Runs a SQL query");
  assert.ok(
    !String(transformed[0].description).includes("STRICT PARAMETERS"),
    "Must NOT inject STRICT PARAMETERS into description by default"
  );
  const schema0 = transformed[0].parametersJsonSchema as { additionalProperties?: boolean };
  assert.equal(schema0.additionalProperties, false);

  // Parameterless tool receives _confirm with type "BOOLEAN" and clean name
  assert.equal(transformed[1].name, "getSystemInfo");
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

test("Tier 2: Response Translation Strips Injected _confirm Argument and Preserves gemini3_ Prefix Unless Legacy Flag Enabled", () => {
  const mockChunkWithConfirm = {
    response: {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "getSystemInfo",
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

  // User tool legitimately named `gemini3_read_file` is preserved when legacy prefixing is off (default),
  // and stripped to `read_file` only when GEMINI_CLI_LEGACY_TOOL_PREFIX=1.
  const mockGemini3NamedToolChunk = {
    response: {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "gemini3_read_file",
                  args: { path: "README.md" },
                  id: "call_read_1",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
  };

  const savedEnv = process.env.GEMINI_CLI_LEGACY_TOOL_PREFIX;
  try {
    delete process.env.GEMINI_CLI_LEGACY_TOOL_PREFIX;
    const defaultChunks = translateGeminiCliChunkToOpenAI(
      mockGemini3NamedToolChunk,
      "gemini-3-flash"
    );
    const defaultStreamName = (
      defaultChunks![0].choices as Array<{
        delta: { tool_calls: Array<{ function: { name: string } }> };
      }>
    )[0].delta.tool_calls[0].function.name;
    assert.equal(defaultStreamName, "gemini3_read_file");

    const defaultFull = translateGeminiCliResponseToOpenAI(
      mockGemini3NamedToolChunk,
      "gemini-3-flash"
    );
    const defaultFullName = (
      defaultFull.choices as Array<{
        message: { tool_calls: Array<{ function: { name: string } }> };
      }>
    )[0].message.tool_calls[0].function.name;
    assert.equal(defaultFullName, "gemini3_read_file");

    process.env.GEMINI_CLI_LEGACY_TOOL_PREFIX = "1";
    const legacyChunks = translateGeminiCliChunkToOpenAI(
      mockGemini3NamedToolChunk,
      "gemini-3-flash"
    );
    const legacyStreamName = (
      legacyChunks![0].choices as Array<{
        delta: { tool_calls: Array<{ function: { name: string } }> };
      }>
    )[0].delta.tool_calls[0].function.name;
    assert.equal(legacyStreamName, "read_file");

    const legacyFull = translateGeminiCliResponseToOpenAI(
      mockGemini3NamedToolChunk,
      "gemini-3-flash"
    );
    const legacyFullName = (
      legacyFull.choices as Array<{
        message: { tool_calls: Array<{ function: { name: string } }> };
      }>
    )[0].message.tool_calls[0].function.name;
    assert.equal(legacyFullName, "read_file");
  } finally {
    if (savedEnv === undefined) delete process.env.GEMINI_CLI_LEGACY_TOOL_PREFIX;
    else process.env.GEMINI_CLI_LEGACY_TOOL_PREFIX = savedEnv;
  }
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

  // Gemini 2.5 default (auto) maps to upstream chat-base-2.5 DEFAULT_THINKING_MODE = 8192
  assert.deepEqual(handleReasoningParameters({}, "gemini-2.5-flash"), {
    thinkingBudget: 8192,
    include_thoughts: true,
  });
  assert.deepEqual(handleReasoningParameters({}, "gemini-2.5-pro"), {
    thinkingBudget: 8192,
    include_thoughts: true,
  });
  assert.deepEqual(handleReasoningParameters({}, "gemini-2.5-flash-lite"), {
    thinkingBudget: 8192,
    include_thoughts: true,
  });

  // Gemini 3.8 Flash & Gemini 3.1/3.5 Flash-Lite recognized as isGem3Flash
  for (const flashModel of ["gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]) {
    assert.deepEqual(
      handleReasoningParameters({ reasoning_effort: "none" }, flashModel),
      { thinkingLevel: "minimal", include_thoughts: true },
      `${flashModel} none -> minimal`
    );
    assert.deepEqual(
      handleReasoningParameters({ reasoning_effort: "medium" }, flashModel),
      { thinkingLevel: "medium", include_thoughts: true },
      `${flashModel} medium -> medium`
    );
  }
});

test("Tier 1: Multi-turn session_id and user_prompt_id continuity, generationConfig defaults, and credits/safety alignment", () => {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const turn1Req: OpenAIChatRequest = {
    model: "gemini-3.8-flash",
    messages: [
      { role: "system", content: "You are a helpful coding assistant. [ts=1000]" },
      { role: "user", content: "hi" },
    ],
  };

  // Turn 2 mutates the system prompt (e.g. dynamic timestamp / workspace state)
  const turn2Req: OpenAIChatRequest = {
    model: "gemini-3.8-flash",
    messages: [
      { role: "system", content: "You are a helpful coding assistant. [ts=2000, cwd=/app]" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! How can I help you today?" },
      { role: "user", content: "Explain how KV cache session affinity works on Code Assist." },
    ],
  };

  // Turn 2 tool-call continuation (no new user text prompt yet, only tool response)
  const turn2ToolContReq: OpenAIChatRequest = {
    model: "gemini-3.8-flash",
    messages: [
      { role: "system", content: "You are a helpful coding assistant. [ts=2005, cwd=/app]" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! How can I help you today?" },
      { role: "user", content: "Explain how KV cache session affinity works on Code Assist." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_doc", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "read_doc", content: '{"ok":true}' },
    ],
  };

  const turn3Req: OpenAIChatRequest = {
    model: "gemini-3.8-flash",
    messages: [
      { role: "system", content: "You are a helpful coding assistant. [ts=3000, cwd=/app]" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! How can I help you today?" },
      { role: "user", content: "Explain how KV cache session affinity works on Code Assist." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_doc", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "read_doc", content: '{"ok":true}' },
      { role: "user", content: "Summarize that doc." },
    ],
  };

  const t1 = translateChatRequestToGeminiCli(turn1Req, { projectId: "proj-1" });
  const t2 = translateChatRequestToGeminiCli(turn2Req, { projectId: "proj-1" });
  const t2Cont = translateChatRequestToGeminiCli(turn2ToolContReq, { projectId: "proj-1" });
  const t3 = translateChatRequestToGeminiCli(turn3Req, { projectId: "proj-1" });

  const s1 = (t1.body.request as Record<string, unknown>).session_id as string;
  const s2 = (t2.body.request as Record<string, unknown>).session_id as string;
  const s2Cont = (t2Cont.body.request as Record<string, unknown>).session_id as string;
  const s3 = (t3.body.request as Record<string, unknown>).session_id as string;

  // Turn 1, Turn 2 (with mutated system prompt), Turn 2 tool continuation, and Turn 3
  // must produce the exact same RFC 4122 UUID v4 session_id
  assert.match(s1, uuidV4Regex);
  assert.equal(
    s1,
    s2,
    "Turn 1 and Turn 2 must share the exact same session_id despite systemInstruction mutation"
  );
  assert.equal(s2, s2Cont, "Turn 2 and Turn 2 tool continuation must share the same session_id");
  assert.equal(s2, s3, "Turn 2 and Turn 3 must share the exact same session_id");

  // user_prompt_id parity:
  // - Single-turn / Turn 1 defaults to sessionId (non-interactive parity, gemini.tsx:968)
  // - Multi-turn interactive prompts format ${sessionId}########${promptIndex} (useGeminiStream.ts:1885)
  //   and stay constant across tool-call continuation turns of the same user prompt!
  assert.equal(t1.body.user_prompt_id, s1);
  assert.equal(t2.body.user_prompt_id, `${s2}########1`);
  assert.equal(t2Cont.body.user_prompt_id, `${s2}########1`);
  assert.equal(t3.body.user_prompt_id, `${s3}########2`);
  assert.equal(generateUserPromptId(s1, 0), `${s1}########0`);

  // Explicit prompt_count: 0 formats ${sessionId}########0 on Turn 1
  const t1Interactive = translateChatRequestToGeminiCli(
    { ...turn1Req, prompt_count: 0 },
    { projectId: "proj-1" }
  );
  assert.equal(t1Interactive.body.user_prompt_id, `${s1}########0`);

  // request.user acts as a salt (differentiating users with identical "hi" prompt)
  // WITHOUT collapsing separate conversations from the same user into one session_id!
  const userAChat1 = translateChatRequestToGeminiCli(
    { ...turn1Req, user: "user-alice" },
    { projectId: "proj-1" }
  );
  const userBChat1 = translateChatRequestToGeminiCli(
    { ...turn1Req, user: "user-bob" },
    { projectId: "proj-1" }
  );
  const userAChat2 = translateChatRequestToGeminiCli(
    {
      model: "gemini-3.8-flash",
      user: "user-alice",
      messages: [{ role: "user", content: "Different conversation topic altogether" }],
    },
    { projectId: "proj-1" }
  );
  const sUserAChat1 = (userAChat1.body.request as Record<string, unknown>).session_id as string;
  const sUserBChat1 = (userBChat1.body.request as Record<string, unknown>).session_id as string;
  const sUserAChat2 = (userAChat2.body.request as Record<string, unknown>).session_id as string;
  assert.notEqual(
    sUserAChat1,
    sUserBChat1,
    "Different users starting with 'hi' must get distinct session_ids"
  );
  assert.notEqual(
    sUserAChat1,
    sUserAChat2,
    "Same request.user on two different conversations must NOT collapse to the same session_id"
  );

  // Synthetic 'Please continue.' is skipped in both primary and fallback anchor searches
  const withSyntheticContinue = generateStableSessionId([
    { role: "user", parts: [{ text: "Please continue." }] },
    { role: "user", parts: [{ text: "Real root prompt" }] },
  ]);
  const directRealPrompt = generateStableSessionId([
    { role: "user", parts: [{ text: "Real root prompt" }] },
  ]);
  assert.equal(withSyntheticContinue, directRealPrompt);

  const fallbackWithSyntheticContinue = generateStableSessionId([
    { role: "user", parts: [{ text: "Please continue." }] },
    { role: "model", parts: [{ text: "Assistant-first context block" }] },
  ]);
  const fallbackDirectModel = generateStableSessionId([
    { role: "model", parts: [{ text: "Assistant-first context block" }] },
  ]);
  assert.equal(
    fallbackWithSyntheticContinue,
    fallbackDirectModel,
    "Fallback anchor search must skip synthetic 'Please continue.' turn"
  );

  // Truncated assistant-first tool histories must NOT anchor on functionResponse-only turns
  // so placeholder vs actual tool results produce the exact same session_id
  const assistantFirstPlaceholder = generateStableSessionId([
    { role: "user", parts: [{ text: "" }] },
    {
      role: "model",
      parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" }, id: "call_abc" } }],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read_file",
            id: "call_abc",
            response: { result: { error: "recovered placeholder", recovered: true } },
          },
        },
      ],
    },
  ]);
  const assistantFirstRealResult = generateStableSessionId([
    { role: "user", parts: [{ text: "" }] },
    {
      role: "model",
      parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" }, id: "call_abc" } }],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read_file",
            id: "call_abc",
            response: { result: "export const x = 1;" },
          },
        },
      ],
    },
  ]);
  assert.equal(
    assistantFirstPlaceholder,
    assistantFirstRealResult,
    "functionResponse-only user turns must not be chosen over earliest model functionCall anchor"
  );

  // Real user typing "Please continue." in messages is preserved as a real user prompt turn
  const realUserContinueTurn2 = translateChatRequestToGeminiCli(
    {
      model: "gemini-3.8-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Part 1 of explanation..." },
        { role: "user", content: "Please continue." },
      ],
    },
    { projectId: "proj-1" }
  );
  assert.equal(
    (realUserContinueTurn2.body.request as Record<string, unknown>).session_id,
    s1,
    "Real user 'Please continue.' on Turn 2 keeps Turn 1 session_id"
  );
  assert.equal(
    realUserContinueTurn2.body.user_prompt_id,
    `${s1}########1`,
    "Real user 'Please continue.' on Turn 2 is counted as user prompt index 1"
  );

  // Explicit session_id overrides content anchor deterministically as UUID v4
  const explicitTranslated = translateChatRequestToGeminiCli(
    { ...turn1Req, session_id: "custom-session-token-42" },
    { projectId: "proj-1" }
  );
  const explicitSess = (explicitTranslated.body.request as Record<string, unknown>)
    .session_id as string;
  assert.match(explicitSess, uuidV4Regex);
  assert.equal(explicitTranslated.body.user_prompt_id, explicitSess);
  assert.notEqual(explicitSess, s1);

  // generationConfig: maxOutputTokens omitted when max_tokens not specified; topP=0.95, topK=64 defaults
  const genConfig1 = (t1.body.request as Record<string, unknown>).generationConfig as Record<
    string,
    unknown
  >;
  assert.equal(
    "maxOutputTokens" in genConfig1,
    false,
    "maxOutputTokens must be omitted by default"
  );
  assert.equal(genConfig1.temperature, 1.0);
  assert.equal(genConfig1.topP, 0.95);
  assert.equal(genConfig1.topK, 64);

  // When max_tokens IS provided, maxOutputTokens is set
  const withMaxTokens = translateChatRequestToGeminiCli(
    { ...turn1Req, max_tokens: 4096, top_p: 0.8, top_k: 40 },
    { projectId: "proj-1" }
  );
  const genConfigMax = (withMaxTokens.body.request as Record<string, unknown>)
    .generationConfig as Record<string, unknown>;
  assert.equal(genConfigMax.maxOutputTokens, 4096);
  assert.equal(genConfigMax.topP, 0.8);
  assert.equal(genConfigMax.topK, 40);

  // safetySettings omitted unless explicitly provided
  assert.equal(
    "safetySettings" in (t1.body.request as Record<string, unknown>),
    false,
    "safetySettings must be omitted when not passed on request"
  );
  const withSafety = translateChatRequestToGeminiCli(
    { ...turn1Req, safetySettings: DEFAULT_SAFETY_SETTINGS },
    { projectId: "proj-1" }
  );
  assert.deepEqual(
    (withSafety.body.request as Record<string, unknown>).safetySettings,
    DEFAULT_SAFETY_SETTINGS
  );

  // enabled_credit_types omitted by default, ignored on untrusted request body,
  // and included when connection.enabledCreditTypes or connection.providerSpecificData is provided
  assert.equal("enabled_credit_types" in t1.body, false);
  const untrustedRequestCredits = translateChatRequestToGeminiCli(
    { ...turn1Req, enabled_credit_types: ["GOOGLE_ONE_AI"] },
    { projectId: "proj-1" }
  );
  assert.equal(
    "enabled_credit_types" in untrustedRequestCredits.body,
    false,
    "Untrusted request.enabled_credit_types must not be forwarded"
  );

  const withCredits = translateChatRequestToGeminiCli(turn1Req, {
    projectId: "proj-1",
    enabledCreditTypes: [" GOOGLE_ONE_AI ", ""],
  });
  assert.deepEqual(withCredits.body.enabled_credit_types, ["GOOGLE_ONE_AI"]);

  const withProviderDataCredits = translateChatRequestToGeminiCli(turn1Req, {
    projectId: "proj-1",
    providerSpecificData: { enabledCreditTypes: ["GOOGLE_ONE_AI"] },
  });
  assert.deepEqual(withProviderDataCredits.body.enabled_credit_types, ["GOOGLE_ONE_AI"]);
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
          assert.equal(reqObj.systemInstruction?.parts[0].text, GEMINI_CLI_SYSTEM_PREAMBLE);
          assert.ok(
            !reqObj.systemInstruction?.parts[0].text.includes("CRITICAL_TOOL_USAGE_INSTRUCTIONS")
          );
          if (tools && tools.length > 0) {
            assert.equal(reqObj.tools?.[0].functionDeclarations[0].name, "calculateSum");
          }
        } else {
          assert.equal(translated.body.model, "gemini-2.5-pro");
          assert.notEqual(genConfig.thinkingConfig?.thinkingBudget, undefined);
        }
      }
    }
  }
});

test("Phase 3: translateChatRequestToGeminiCli scrubs 3rd-party system prompts, prepends Gemini CLI preamble without double-prepending, and preserves clean tool declarations", () => {
  clearGeminiThoughtSignatureMemoryForTests();

  const reqWithThirdPartyPrompt: OpenAIChatRequest = {
    model: "gemini-3-flash",
    messages: [
      {
        role: "system",
        content: [
          "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
          "You are OpenCode, an interactive CLI agent.",
          "See https://hermes-agent.nousresearch.com and github.com/anomalyco/opencode.",
          "Project rule: use strict TypeScript.",
        ].join("\n\n"),
      },
      { role: "user", content: "Read the config file and run tests" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"tsconfig.json"}' },
          },
          {
            id: "call_bash_2",
            type: "function",
            function: { name: "bash", arguments: '{"command":"npm test"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_read_1",
        name: "read_file",
        content: '{"compilerOptions":{"strict":true}}',
      },
      {
        role: "tool",
        tool_call_id: "call_bash_2",
        name: "bash",
        content: '{"exitCode":0}',
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Reads a file from disk",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "bash",
          description: "Executes a bash command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "read_file" } },
  };

  const translated = translateChatRequestToGeminiCli(reqWithThirdPartyPrompt, {
    projectId: "proj-phase3",
  });
  const reqPayload = translated.body.request as {
    systemInstruction?: { role: string; parts: Array<{ text: string }> };
    tools?: Array<{ functionDeclarations: Array<{ name: string; description: string }> }>;
    toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
    contents: Array<{
      role: string;
      parts: Array<{
        text?: string;
        thoughtSignature?: string;
        functionCall?: { name: string; id: string };
        functionResponse?: { name: string; id: string };
      }>;
    }>;
  };

  // 1. System prompt scrubbed and preamble prepended
  const sysText = reqPayload.systemInstruction?.parts[0].text || "";
  assert.ok(sysText.startsWith(GEMINI_CLI_SYSTEM_PREAMBLE));
  assert.ok(!sysText.includes("You are Hermes Agent"));
  assert.ok(!sysText.includes("You are OpenCode"));
  assert.ok(!sysText.includes("hermes-agent.nousresearch.com"));
  assert.ok(!sysText.includes("github.com/anomalyco/opencode"));
  assert.ok(!sysText.includes("CRITICAL_TOOL_USAGE_INSTRUCTIONS"));
  assert.ok(sysText.includes("Project rule: use strict TypeScript."));

  // 2. Clean tool declarations and toolConfig without gemini3_ or STRICT PARAMETERS
  const decls = reqPayload.tools?.[0].functionDeclarations || [];
  assert.equal(decls.length, 2);
  assert.equal(decls[0].name, "read_file");
  assert.equal(decls[0].description, "Reads a file from disk");
  assert.equal(decls[1].name, "bash");
  assert.equal(decls[1].description, "Executes a bash command");
  assert.deepEqual(reqPayload.toolConfig?.functionCallingConfig.allowedFunctionNames, ["read_file"]);

  // 3. Clean functionCall and functionResponse names + thoughtSignature on first functionCall only
  const modelTurn = reqPayload.contents.find((c) => c.role === "model");
  assert.ok(modelTurn);
  assert.equal(modelTurn.parts[0].functionCall?.name, "read_file");
  assert.equal(modelTurn.parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(modelTurn.parts[1].functionCall?.name, "bash");
  assert.equal(modelTurn.parts[1].thoughtSignature, undefined);

  const lastTurn = reqPayload.contents.at(-1);
  assert.ok(lastTurn);
  assert.equal(lastTurn.role, "user");
  assert.equal(lastTurn.parts[0].functionResponse?.name, "read_file");
  assert.equal(lastTurn.parts[1].functionResponse?.name, "bash");

  // 4. Does not double-prepend when "You are Gemini CLI" is already present
  const alreadyGeminiReq: OpenAIChatRequest = {
    model: "gemini-3-flash",
    messages: [
      {
        role: "system",
        content: `${GEMINI_CLI_SYSTEM_PREAMBLE}\n\nAdditional custom instructions.`,
      },
      { role: "user", content: "Hello" },
    ],
  };
  const alreadyTranslated = translateChatRequestToGeminiCli(alreadyGeminiReq);
  const alreadySysText =
    (
      alreadyTranslated.body.request as {
        systemInstruction?: { parts: Array<{ text: string }> };
      }
    ).systemInstruction?.parts[0].text || "";
  assert.equal(alreadySysText, `${GEMINI_CLI_SYSTEM_PREAMBLE}\n\nAdditional custom instructions.`);
});

test("Phase 3: translateChatRequestToGeminiCli does not mutate caller request in place and applies obfuscate_words to outgoing contents and tools", () => {
  try {
    setSystemTransformsConfig({
      providers: {
        [PROVIDER_GEMINI_CLI]: {
          enabled: true,
          pipeline: [
            ...DEFAULT_GEMINI_CLI_PIPELINE,
            {
              kind: "obfuscate_words",
              words: ["opencode"],
              targets: ["system", "messages", "tools"],
            },
          ],
        },
      },
    });

    const callerReq: OpenAIChatRequest = {
      model: "gemini-3-flash",
      messages: [
        { role: "system", content: "Helper for opencode workflow." },
        { role: "user", content: "Run opencode check" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "check_env",
            description: "Checks opencode environment",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    const snapshotBefore = JSON.stringify(callerReq);

    const translated = translateChatRequestToGeminiCli(callerReq);
    // Caller request must not be mutated in place
    assert.equal(JSON.stringify(callerReq), snapshotBefore);

    const reqPayload = translated.body.request as {
      systemInstruction?: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
      tools?: Array<{ functionDeclarations: Array<{ description: string }> }>;
    };
    const zwjWord = "o\u200dpencode";
    assert.ok(reqPayload.systemInstruction?.parts[0].text.includes(zwjWord));
    assert.ok(reqPayload.contents[0].parts[0].text?.includes(zwjWord));
    assert.ok(reqPayload.tools?.[0].functionDeclarations[0].description.includes(zwjWord));

    // Also verify targets: ["messages"] on messages-only input obfuscates both systemInstruction and contents
    setSystemTransformsConfig({
      providers: {
        [PROVIDER_GEMINI_CLI]: {
          enabled: true,
          pipeline: [
            {
              kind: "obfuscate_words",
              words: ["opencode"],
              targets: ["messages"],
            },
          ],
        },
      },
    });
    const messagesTargetTranslated = translateChatRequestToGeminiCli(callerReq);
    const messagesTargetPayload = messagesTargetTranslated.body.request as {
      systemInstruction?: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };
    assert.equal(
      messagesTargetPayload.systemInstruction?.parts[0].text,
      `Helper for ${zwjWord} workflow.`
    );
    assert.equal(messagesTargetPayload.contents[0].parts[0].text, `Run ${zwjWord} check`);
  } finally {
    resetSystemTransformsConfig();
  }
});

test("Phase 3: ensureTerminalUserTurn replaces empty or metadata-only terminal user parts with CONTINUE_PROMPT_TEXT", () => {
  const emptyObjectTurn = ensureTerminalUserTurn([{ role: "user", parts: [{}] }]);
  assert.deepEqual(emptyObjectTurn, [{ role: "user", parts: [{ text: CONTINUE_PROMPT_TEXT }] }]);

  const thoughtOnlyTurn = ensureTerminalUserTurn([{ role: "user", parts: [{ thought: false }] }]);
  assert.deepEqual(thoughtOnlyTurn, [{ role: "user", parts: [{ text: CONTINUE_PROMPT_TEXT }] }]);

  const whitespaceOnlyTurn = ensureTerminalUserTurn([{ role: "user", parts: [{ text: "   " }] }]);
  assert.deepEqual(whitespaceOnlyTurn, [{ role: "user", parts: [{ text: CONTINUE_PROMPT_TEXT }] }]);

  const emptyInlineDataTurn = ensureTerminalUserTurn([
    { role: "user", parts: [{ inlineData: {} }, { fileData: {} }] },
  ]);
  assert.deepEqual(emptyInlineDataTurn, [
    { role: "user", parts: [{ text: CONTINUE_PROMPT_TEXT }] },
  ]);

  const validInlineDataTurn = ensureTerminalUserTurn([
    { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "YWJj" } }] },
  ]);
  assert.deepEqual(validInlineDataTurn, [
    { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "YWJj" } }] },
  ]);

  const modelTerminalTurn = ensureTerminalUserTurn([
    { role: "user", parts: [{ text: "Hello" }] },
    { role: "model", parts: [{ text: "Thinking..." }] },
  ]);
  assert.equal(modelTerminalTurn.length, 3);
  assert.deepEqual(modelTerminalTurn[2], {
    role: "user",
    parts: [{ text: CONTINUE_PROMPT_TEXT }],
  });
});

test("Phase 3: authentic @google/gemini-cli functionResponse contract with { id, name, response: { output } }", () => {
  const request = {
    model: "gemini-3.8-flash",
    messages: [
      { role: "user", content: "Check node status" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_check_1",
            type: "function",
            function: { name: "get_cluster_status", arguments: '{"node":"dfw-01"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_check_1",
        name: "get_cluster_status",
        content: JSON.stringify({ output: "Node dfw-01 is HEALTHY" }),
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_cluster_status",
          parameters: { type: "object", properties: { node: { type: "string" } } },
        },
      },
    ],
  };

  const translated = translateChatRequestToGeminiCli(request, { projectId: "proj-tool-val" });
  const contents = translated.body.request.contents as Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;

  assert.equal(contents.length, 3);
  assert.equal(contents[0].role, "user");
  assert.equal(contents[1].role, "model");
  assert.equal(contents[2].role, "user");

  const frPart = contents[2].parts[0].functionResponse as {
    id: string;
    name: string;
    response: { output: string };
  };
  assert.ok(frPart, "expected functionResponse part");
  assert.equal(frPart.id, "call_check_1");
  assert.equal(frPart.name, "get_cluster_status");
  assert.deepEqual(frPart.response, { output: "Node dfw-01 is HEALTHY" });

  // Verify key order: id first, name second, response third
  assert.deepEqual(Object.keys(frPart), ["id", "name", "response"]);

  // Verify user_prompt_id matches session_id on tool response turn
  const sessionId = translated.body.request.session_id as string;
  const userPromptId = translated.body.user_prompt_id as string;
  assert.equal(userPromptId, sessionId, "user_prompt_id on tool-response turn must stay identical to sessionId");
});
