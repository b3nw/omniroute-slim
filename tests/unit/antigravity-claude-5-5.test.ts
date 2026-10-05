// Claude 5.5 on Antigravity / agy: catalog, 128k output cap, thinkingLevel steering,
// Claude 5.5 signature recognition, the unsigned-thinking outbound guard and 400
// circuit breaker (Antigravity-Manager #3587 / #3593), and the model-scoped
// entitlement isolation for 404/403 on accounts without Pro/Ultra.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// chatCore's DB layer resolves DATA_DIR when it is first imported, so point it at a temp
// dir before loading any project module (the chatCore test below writes call logs).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude55-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { OAUTH_ENDPOINTS } = await import("../../open-sse/config/constants.ts");

const {
  ANTIGRAVITY_MODEL_ALIASES,
  ANTIGRAVITY_PUBLIC_MODELS,
  isUserCallableAntigravityModelId,
  resolveAntigravityModelId,
} = await import("../../open-sse/config/antigravityModelAliases.ts");
const { AGY_PUBLIC_MODELS, isUserCallableAgyModelId } =
  await import("../../open-sse/config/agyModels.ts");
const {
  AntigravityExecutor,
  sanitizeThinkingSignatures,
  __test_applyAntigravityGenerationDefaults: applyAntigravityGenerationDefaults,
} = await import("../../open-sse/executors/antigravity.ts");
const { resolveAntigravityOutputCap } =
  await import("../../open-sse/executors/antigravityOutputCap.ts");
const { getAntigravityClaudeOutputTokens, openaiToAntigravityRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { shouldStripCloudCodeThinking, stripCloudCodeThinkingConfig } =
  await import("../../open-sse/services/cloudCodeThinking.ts");
const {
  ANTIGRAVITY_CLAUDE_55_ENTITLEMENT_COOLDOWN_MS,
  ANTIGRAVITY_CLAUDE_55_MODEL_METADATA,
  guardClaude55ThinkingParts,
  isAntigravityClaude55Model,
  isClaude55Signature,
  isThinkingSignature400,
  resolveClaude55DispatchTier,
  resolveClaude55Tier,
  toClaude55TieredModelId,
} = await import("../../open-sse/services/antigravityClaude55.ts");
const {
  checkFallbackError,
  clearAllModelLockouts,
  getModelLockoutInfo,
  isAntigravityClaude55EntitlementFailure,
  isModelLocked,
  lockModel,
  lockModelIfPerModelQuota,
  recordAntigravityClaude55EntitlementLockout,
} = await import("../../open-sse/services/accountFallback.ts");
const { getQuotaScopeLabelForProvider, getQuotaScopedModelForProvider } =
  await import("../../open-sse/services/antigravityQuotaFamily.ts");
const { PROVIDER_ERROR_TYPES, classifyProviderError } =
  await import("../../open-sse/services/errorClassifier.ts");
const {
  clearGeminiThoughtSignatureMemoryForTests,
  getGeminiThoughtSignature,
  storeGeminiThoughtSignature,
} = await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
const {
  clearAntigravityVersionCaches,
  seedAntigravityCliVersionCache,
  seedAntigravityIdeVersionCache,
} = await import("../../open-sse/services/antigravityVersion.ts");

const { applyClaudeEffortVariant } =
  await import("../../open-sse/handlers/chatCore/claudeEffortVariant.ts");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.ts");

const CLAUDE_55_IDS = [
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
];

// Protobuf wire bytes 0x08 0x04 0x12 <len> <payload> → base64 "CAQS…".
const NATIVE_SIGNATURE = Buffer.concat([
  Buffer.from([0x08, 0x04, 0x12, 0x10]),
  Buffer.from("claude-5-5-signature-payload-bytes"),
]).toString("base64");
const WRAPPED_SIGNATURE = Buffer.from(NATIVE_SIGNATURE).toString("base64");
const DOUBLE_WRAPPED_SIGNATURE = Buffer.from(WRAPPED_SIGNATURE).toString("base64");
const GEMINI_SIGNATURE = "EuYBCuMBAXLI2nwGeminiStyleThoughtSignaturePayload==";

type Part = Record<string, unknown>;
type Envelope = {
  model: string;
  request: {
    contents: Array<{ role: string; parts: Part[] }>;
    generationConfig: Record<string, unknown> & {
      thinkingConfig?: Record<string, unknown>;
    };
  };
};

const CREDS = { accessToken: "token", projectId: "project-1" };
const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

function multiTurnMessages(assistant: Record<string, unknown>) {
  return [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer", ...assistant },
    { role: "user", content: "follow-up" },
  ];
}

async function readFetchBody(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const body = init?.body;
  const text = typeof body === "string" ? body : await new Response(body as BodyInit).text();
  return JSON.parse(text);
}

function sseOk(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      response: {
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      },
    })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

test.beforeEach(() => {
  seedAntigravityIdeVersionCache("2026.10.01-test");
  seedAntigravityCliVersionCache("2026.10.01-test");
});
test.afterEach(() => {
  clearAntigravityVersionCaches();
});
test.after(async () => {
  // chatCore persists call logs off the request path; let them land before removing the dir.
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── 1. Catalog & aliases ─────────────────────────────────────────────────────

test("catalog: all six Claude 5.5 tiers are registered for antigravity and agy", () => {
  for (const catalog of [ANTIGRAVITY_PUBLIC_MODELS, AGY_PUBLIC_MODELS]) {
    for (const id of CLAUDE_55_IDS) {
      const entry = catalog.find((model) => model.id === id);
      assert.ok(entry, `${id} missing from catalog`);
      assert.equal(entry.contextLength, 1_000_000);
      assert.equal(entry.maxOutputTokens, 128_000);
      assert.equal(entry.supportsReasoning, true);
      assert.equal(entry.supportsVision, true);
      assert.equal(entry.toolCalling, true);
    }
  }
  assert.equal(
    ANTIGRAVITY_CLAUDE_55_MODEL_METADATA["claude-opus-5-5-low"].internalModelId,
    "MODEL_PLACEHOLDER_M400"
  );
  assert.equal(
    ANTIGRAVITY_CLAUDE_55_MODEL_METADATA["claude-sonnet-5-5-high"].internalModelId,
    "MODEL_PLACEHOLDER_M405"
  );
  assert.equal(
    ANTIGRAVITY_CLAUDE_55_MODEL_METADATA["claude-opus-5-5-high"].vertexModelId,
    "claude-opus-5-5@default"
  );
  assert.equal(
    ANTIGRAVITY_CLAUDE_55_MODEL_METADATA["claude-sonnet-5-5-medium"].vertexModelId,
    "claude-sonnet-5-5@default"
  );
});

test("aliases: bare Claude 5.5 ids resolve to the medium tier; tiered ids pass through", () => {
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["claude-opus-5-5"], "claude-opus-5-5-medium");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["claude-sonnet-5-5"], "claude-sonnet-5-5-medium");
  assert.equal(resolveAntigravityModelId("claude-opus-5-5"), "claude-opus-5-5-medium");
  assert.equal(resolveAntigravityModelId("claude-sonnet-5-5"), "claude-sonnet-5-5-medium");
  assert.equal(resolveAntigravityModelId("claude-opus-5.5"), "claude-opus-5-5-medium");
  for (const id of CLAUDE_55_IDS) assert.equal(resolveAntigravityModelId(id), id);

  assert.equal(isUserCallableAntigravityModelId("claude-opus-5-5"), true);
  assert.equal(isUserCallableAntigravityModelId("claude-sonnet-5-5-high"), true);
  assert.equal(isUserCallableAgyModelId("claude-sonnet-5-5"), true);
  assert.equal(isUserCallableAgyModelId("claude-opus-5-5-low"), true);
});

test("model detection accepts prefixed/bare/tiered 5.5 ids and rejects other Claude generations", () => {
  assert.equal(isAntigravityClaude55Model("antigravity/claude-opus-5-5-high"), true);
  assert.equal(isAntigravityClaude55Model("agy/claude-sonnet-5-5"), true);
  assert.equal(isAntigravityClaude55Model("models/claude-opus-5.5"), true);
  assert.equal(isAntigravityClaude55Model("claude-sonnet-4-6"), false);
  assert.equal(isAntigravityClaude55Model("claude-opus-4-6-thinking"), false);
  assert.equal(isAntigravityClaude55Model("gemini-3.7-flash-high"), false);
});

test("thinking aliases: -thinking ids are Claude 5.5, resolve to medium, cap at 128k and are callable", () => {
  const aliases: Array<[string, string]> = [
    ["claude-opus-5-5-thinking", "claude-opus-5-5-medium"],
    ["claude-sonnet-5-5-thinking", "claude-sonnet-5-5-medium"],
    ["claude-opus-5.5-thinking", "claude-opus-5-5-medium"],
    ["claude-sonnet-5.5-thinking", "claude-sonnet-5-5-medium"],
  ];
  for (const [alias, upstream] of aliases) {
    assert.equal(isAntigravityClaude55Model(alias), true, alias);
    assert.equal(isAntigravityClaude55Model(`antigravity/${alias}`), true, alias);
    assert.equal(resolveClaude55Tier(alias), "medium", alias);
    assert.equal(resolveClaude55Tier(alias, "high"), "medium", `${alias} suffix beats effort`);
    assert.equal(resolveAntigravityModelId(alias), upstream, alias);
    assert.equal(resolveAntigravityOutputCap(alias), 128_000, alias);
    assert.equal(getAntigravityClaudeOutputTokens({ max_tokens: 400_000 }, alias), 128_000, alias);
    assert.equal(isUserCallableAntigravityModelId(alias), true, alias);
    assert.equal(isUserCallableAgyModelId(alias), true, alias);

    const envelope = openaiToAntigravityRequest(
      alias,
      { messages: [{ role: "user", content: "hi" }], max_tokens: 100_000 },
      true,
      CREDS
    ) as unknown as Envelope;
    assert.equal(envelope.model, upstream, alias);
    assert.equal(envelope.request.generationConfig.thinkingConfig?.thinkingLevel, 2, alias);
    assert.equal(envelope.request.generationConfig.thinkingConfig?.thinkingBudget, undefined);
    assert.equal(envelope.request.generationConfig.maxOutputTokens, 100_000, alias);
  }
  // Older Claude -thinking ids stay outside the 5.5 path.
  assert.equal(isAntigravityClaude55Model("claude-opus-4-6-thinking"), false);
});

// ── 2. 128k output cap ───────────────────────────────────────────────────────

test("output cap: Claude 5.5 resolves to 128,000, not the 64k/16k ceilings", () => {
  for (const id of CLAUDE_55_IDS) assert.equal(resolveAntigravityOutputCap(id), 128_000);
  assert.equal(resolveAntigravityOutputCap("claude-sonnet-4-6"), 65_536);

  const request: Record<string, unknown> = { generationConfig: { maxOutputTokens: 500_000 } };
  applyAntigravityGenerationDefaults(request, "claude-opus-5-5-high");
  assert.equal((request.generationConfig as Record<string, unknown>).maxOutputTokens, 128_000);

  const within: Record<string, unknown> = { generationConfig: { maxOutputTokens: 100_000 } };
  applyAntigravityGenerationDefaults(within, "claude-sonnet-5-5-low");
  assert.equal((within.generationConfig as Record<string, unknown>).maxOutputTokens, 100_000);
});

test("translator output cap: Claude 5.5 allows up to 128k, older Claude keeps the 16k wrapper cap", () => {
  assert.equal(
    getAntigravityClaudeOutputTokens({ max_tokens: 100_000 }, "claude-opus-5-5-high"),
    100_000
  );
  assert.equal(
    getAntigravityClaudeOutputTokens({ max_tokens: 400_000 }, "claude-opus-5-5-high"),
    128_000
  );
  assert.equal(getAntigravityClaudeOutputTokens({}, "claude-sonnet-5-5"), 128_000);
  assert.equal(
    getAntigravityClaudeOutputTokens({ max_tokens: 100_000 }, "claude-sonnet-4-6"),
    16_384
  );

  const envelope = openaiToAntigravityRequest(
    "claude-opus-5-5-high",
    { messages: [{ role: "user", content: "hi" }], max_tokens: 100_000 },
    true,
    CREDS
  ) as unknown as Envelope;
  assert.equal(envelope.request.generationConfig.maxOutputTokens, 100_000);
});

// ── 3. thinkingLevel ─────────────────────────────────────────────────────────

test("thinkingLevel: tier suffix maps -low/-medium/-high to 1/2/3 with no thinkingBudget", () => {
  const expected: Record<string, number> = { low: 1, medium: 2, high: 3 };
  for (const id of CLAUDE_55_IDS) {
    const envelope = openaiToAntigravityRequest(
      id,
      { messages: [{ role: "user", content: "hi" }] },
      true,
      CREDS
    ) as unknown as Envelope;
    const tier = id.split("-").pop() as string;
    const thinkingConfig = envelope.request.generationConfig.thinkingConfig;
    assert.ok(thinkingConfig, `${id} must keep thinkingConfig`);
    assert.equal(thinkingConfig.thinkingLevel, expected[tier], id);
    assert.equal("thinkingBudget" in thinkingConfig, false, `${id} must not send thinkingBudget`);
    assert.equal(envelope.model, id);
  }
});

test("thinkingLevel: bare id takes the tier from reasoning_effort (and the upstream id follows)", () => {
  const cases: Array<[string, number, string]> = [
    ["low", 1, "claude-opus-5-5-low"],
    ["medium", 2, "claude-opus-5-5-medium"],
    ["high", 3, "claude-opus-5-5-high"],
  ];
  for (const [effort, level, upstream] of cases) {
    const envelope = openaiToAntigravityRequest(
      "claude-opus-5-5",
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: effort },
      true,
      CREDS
    ) as unknown as Envelope;
    assert.equal(envelope.request.generationConfig.thinkingConfig?.thinkingLevel, level);
    assert.equal(envelope.request.generationConfig.thinkingConfig?.thinkingBudget, undefined);
    assert.equal(envelope.model, upstream);
  }
  // No effort → medium; an explicit suffix beats a conflicting effort.
  assert.equal(resolveClaude55Tier("claude-sonnet-5-5"), "medium");
  assert.equal(resolveClaude55Tier("claude-sonnet-5-5-low", "high"), "low");
});

test("thinkingConfig is not stripped for Claude 5.5 (but still is for Claude 4.x)", () => {
  assert.equal(shouldStripCloudCodeThinking("antigravity", "claude-opus-5-5-high"), false);
  assert.equal(shouldStripCloudCodeThinking("agy", "antigravity/claude-sonnet-5-5"), false);
  assert.equal(shouldStripCloudCodeThinking("antigravity", "claude-sonnet-4-6"), true);
  // Sanity: the legacy strip helper itself is unchanged.
  const stripped = stripCloudCodeThinkingConfig({
    request: { generationConfig: { thinkingConfig: { thinkingLevel: 2 } } },
  });
  assert.equal(
    "thinkingConfig" in ((stripped.request as Record<string, unknown>).generationConfig as object),
    false
  );

  const legacy = openaiToAntigravityRequest(
    "claude-sonnet-4-6",
    { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
    true,
    CREDS
  ) as unknown as Envelope;
  assert.equal(legacy.request.generationConfig.thinkingConfig, undefined);
});

test("executor: thinkingLevel survives transformRequest and replaces a native thinkingBudget", async () => {
  const executor = new AntigravityExecutor();
  const translated = openaiToAntigravityRequest(
    "claude-sonnet-5-5",
    { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
    true,
    CREDS
  );
  const out = (await executor.transformRequest(
    "antigravity/claude-sonnet-5-5",
    translated,
    true,
    CREDS
  )) as unknown as Envelope;
  assert.equal(out.model, "claude-sonnet-5-5-high");
  assert.deepEqual(out.request.generationConfig.thinkingConfig, {
    thinkingLevel: 3,
    includeThoughts: true,
  });

  const native = (await executor.transformRequest(
    "antigravity/claude-opus-5-5-low",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 32_000, includeThoughts: true } },
      },
    },
    true,
    CREDS
  )) as unknown as Envelope;
  assert.equal(native.model, "claude-opus-5-5-low");
  assert.equal(native.request.generationConfig.thinkingConfig?.thinkingLevel, 1);
  assert.equal(native.request.generationConfig.thinkingConfig?.thinkingBudget, undefined);
});

// ── 4. Signature recognition ─────────────────────────────────────────────────

test("isClaude55Signature recognizes CAQS protobuf and Q0FR (multi-layer) base64 wrappers", () => {
  assert.ok(NATIVE_SIGNATURE.startsWith("CAQS"));
  assert.ok(WRAPPED_SIGNATURE.startsWith("Q0FR"));
  assert.equal(isClaude55Signature(NATIVE_SIGNATURE), true);
  assert.equal(isClaude55Signature(WRAPPED_SIGNATURE), true);
  assert.equal(isClaude55Signature(DOUBLE_WRAPPED_SIGNATURE), true);

  assert.equal(isClaude55Signature(GEMINI_SIGNATURE), false);
  assert.equal(isClaude55Signature("skip_thought_signature_validator"), false);
  assert.equal(isClaude55Signature("CAQS"), false, "bare tag with no payload");
  assert.equal(isClaude55Signature("CAQS not base64 !!"), false);
  assert.equal(isClaude55Signature(""), false);
  assert.equal(isClaude55Signature(undefined), false);
  assert.equal(isClaude55Signature(12345), false);
});

// ── 5. Outbound guard: unsigned thinking → <think> text ──────────────────────

test("translator: unsigned reasoning_content on Claude 5.5 is downgraded to <think> text", () => {
  const envelope = openaiToAntigravityRequest(
    "claude-opus-5-5-high",
    { messages: multiTurnMessages({ reasoning_content: "secret plan" }) },
    true,
    CREDS
  ) as unknown as Envelope;
  const parts = envelope.request.contents.flatMap((c) => c.parts);
  assert.equal(
    parts.some((p) => p.thought === true),
    false,
    "no unsigned thought part may be sent"
  );
  assert.ok(parts.some((p) => p.text === "<think>\nsecret plan\n</think>"));
});

test("translator: signed reasoning_content on Claude 5.5 is replayed as a native thought part", () => {
  for (const signatureField of [
    { reasoning_signature: NATIVE_SIGNATURE },
    { reasoning_details: [{ type: "reasoning.text", text: "x", signature: WRAPPED_SIGNATURE }] },
  ]) {
    const envelope = openaiToAntigravityRequest(
      "claude-opus-5-5-high",
      { messages: multiTurnMessages({ reasoning_content: "signed plan", ...signatureField }) },
      true,
      CREDS
    ) as unknown as Envelope;
    const thought = envelope.request.contents
      .flatMap((c) => c.parts)
      .find((p) => p.thought === true);
    assert.ok(thought, "signed thought must be kept");
    assert.equal(thought.text, "signed plan");
    assert.ok(isClaude55Signature(thought.thoughtSignature));
  }
});

test("translator: a foreign (Gemini) signature does not qualify a Claude 5.5 thought part", () => {
  const envelope = openaiToAntigravityRequest(
    "claude-sonnet-5-5-medium",
    {
      messages: multiTurnMessages({
        reasoning_content: "plan",
        reasoning_signature: GEMINI_SIGNATURE,
      }),
    },
    true,
    CREDS
  ) as unknown as Envelope;
  const parts = envelope.request.contents.flatMap((c) => c.parts);
  assert.equal(
    parts.some((p) => p.thought === true),
    false
  );
  assert.equal(
    parts.some((p) => p.thoughtSignature === GEMINI_SIGNATURE),
    false
  );
});

test("executor: unsigned thought parts become <think> text, signed ones are kept for Claude 5.5", async () => {
  const executor = new AntigravityExecutor();
  const out = (await executor.transformRequest(
    "antigravity/claude-opus-5-5-high",
    {
      request: {
        contents: [
          { role: "user", parts: [{ text: "q1" }] },
          {
            role: "model",
            parts: [
              { thought: true, text: "unsigned reasoning" },
              { thought: true, text: "signed reasoning", thoughtSignature: NATIVE_SIGNATURE },
              { text: "answer", thoughtSignature: GEMINI_SIGNATURE },
            ],
          },
          { role: "user", parts: [{ text: "q2" }] },
        ],
      },
    },
    true,
    CREDS
  )) as unknown as Envelope;

  const modelParts = out.request.contents.find((c) => c.role === "model")?.parts ?? [];
  assert.deepEqual(modelParts[0], { text: "<think>\nunsigned reasoning\n</think>" });
  assert.equal(modelParts[1].thought, true);
  assert.equal(modelParts[1].thoughtSignature, NATIVE_SIGNATURE);
  assert.deepEqual(modelParts[2], { text: "answer" }, "foreign signature dropped, text kept");
  assert.equal(
    modelParts.filter((p) => p.thought === true && !isClaude55Signature(p.thoughtSignature)).length,
    0
  );
});

test("executor: non-5.5 models keep the legacy behavior of dropping thought parts", async () => {
  const executor = new AntigravityExecutor();
  const out = (await executor.transformRequest(
    "antigravity/claude-sonnet-4-6",
    {
      request: {
        contents: [
          { role: "user", parts: [{ text: "q1" }] },
          { role: "model", parts: [{ thought: true, text: "r" }, { text: "a" }] },
          { role: "user", parts: [{ text: "q2" }] },
        ],
      },
    },
    true,
    CREDS
  )) as unknown as Envelope;
  const modelParts = out.request.contents.find((c) => c.role === "model")?.parts ?? [];
  assert.deepEqual(modelParts, [{ text: "a" }]);
});

test("guardClaude55ThinkingParts(forceDowngrade) strips every signature and thought flag", () => {
  const parts = guardClaude55ThinkingParts(
    [
      { thought: true, text: "r", thoughtSignature: NATIVE_SIGNATURE },
      { text: "t", thoughtSignature: NATIVE_SIGNATURE },
      { functionCall: { id: "c1", name: "f", args: {} }, thoughtSignature: GEMINI_SIGNATURE },
    ],
    { forceDowngrade: true }
  );
  assert.deepEqual(parts[0], { text: "<think>\nr\n</think>" });
  assert.deepEqual(parts[1], { text: "t" });
  assert.equal(parts[2].thoughtSignature, "skip_thought_signature_validator");
});

// ── 6. 400 signature circuit breaker ─────────────────────────────────────────

test("isThinkingSignature400 matches only the Anthropic thinking-signature 400s", () => {
  assert.equal(
    isThinkingSignature400(
      400,
      '{"error":{"message":"messages.1.content.0.thinking.signature: Field required"}}'
    ),
    true
  );
  assert.equal(isThinkingSignature400(400, "Invalid `signature` in `thinking` block"), true);
  assert.equal(isThinkingSignature400(400, "Invalid argument: maxOutputTokens"), false);
  assert.equal(isThinkingSignature400(429, "thinking.signature: Field required"), false);
});

test("execute: 400 thinking.signature triggers ONE in-place retry with thinking downgraded to text", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: await readFetchBody(init) });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "messages.1.content.0.thinking.signature: Field required",
            status: "INVALID_ARGUMENT",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    return sseOk("recovered");
  }) as typeof fetch;

  try {
    const result = await executor.execute({
      model: "antigravity/claude-opus-5-5-high",
      body: {
        request: {
          contents: [
            { role: "user", parts: [{ text: "q1" }] },
            {
              role: "model",
              parts: [
                // Signature looks valid locally but the upstream rejected it (poisoned).
                { thought: true, text: "stale reasoning", thoughtSignature: NATIVE_SIGNATURE },
                { text: "a1" },
              ],
            },
            { role: "user", parts: [{ text: "q2" }] },
          ],
        },
      },
      stream: false,
      credentials: CREDS,
      log: SILENT_LOG,
    } as never);

    assert.equal(calls.length, 2, "exactly one in-place retry");
    assert.equal(calls[0].url, calls[1].url, "retry stays on the same endpoint/account");
    const firstParts = JSON.stringify(calls[0].body);
    assert.match(firstParts, /"thought":true/);

    const retried = calls[1].body.request as Envelope["request"];
    const retriedParts = retried.contents.flatMap((c) => c.parts);
    assert.equal(
      retriedParts.some((p) => p.thought === true),
      false
    );
    assert.equal(
      retriedParts.some((p) => "thoughtSignature" in p),
      false
    );
    assert.ok(retriedParts.some((p) => p.text === "<think>\nstale reasoning\n</think>"));
    assert.equal(result.response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("execute: the sanitized body survives a retryable response and is reused on the fallback host", async () => {
  const cases: Array<{ status: number; headers: Record<string, string> }> = [
    { status: 502, headers: {} },
    // A long Retry-After skips the same-URL backoff and moves to the next host.
    { status: 503, headers: { "Retry-After": "3600" } },
  ];
  for (const failure of cases) {
    clearGeminiThoughtSignatureMemoryForTests();
    const executor = new AntigravityExecutor();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: await readFetchBody(init) });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "messages.1.content.0.thinking.signature: Field required",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify({ error: { code: failure.status, message: "busy" } }), {
          status: failure.status,
          headers: { "Content-Type": "application/json", ...failure.headers },
        });
      }
      return sseOk("recovered on fallback host");
    }) as typeof fetch;

    try {
      const result = await executor.execute({
        model: "antigravity/claude-opus-5-5-high",
        body: {
          request: {
            contents: [
              { role: "user", parts: [{ text: "q1" }] },
              {
                role: "model",
                parts: [
                  { thought: true, text: "stale reasoning", thoughtSignature: NATIVE_SIGNATURE },
                  { text: "a1" },
                ],
              },
              { role: "user", parts: [{ text: "q2" }] },
            ],
          },
        },
        stream: false,
        credentials: CREDS,
        log: SILENT_LOG,
      } as never);

      assert.equal(calls.length, 3, `${failure.status}: 400 → sanitized retry → fallback host`);
      assert.equal(calls[0].url, calls[1].url, "signature retry stays in place");
      assert.notEqual(calls[1].url, calls[2].url, `${failure.status}: moved to the fallback host`);
      for (const call of calls.slice(1)) {
        const parts = (call.body.request as Envelope["request"]).contents.flatMap((c) => c.parts);
        assert.equal(
          parts.some((p) => p.thought === true || "thoughtSignature" in p),
          false,
          `${failure.status}: rejected signatures must not be revived on ${call.url}`
        );
        assert.ok(parts.some((p) => p.text === "<think>\nstale reasoning\n</think>"));
      }
      assert.equal(result.response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  clearGeminiThoughtSignatureMemoryForTests();
});

test("execute: a non-signature 400 is not retried", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 400, message: "Invalid argument" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await executor.execute({
      model: "antigravity/claude-opus-5-5-high",
      body: { request: { contents: [{ role: "user", parts: [{ text: "q" }] }] } },
      stream: false,
      credentials: CREDS,
      log: SILENT_LOG,
    } as never);
    assert.equal(calls, 1);
    assert.equal(result.response.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sanitizeThinkingSignatures purges every cached signature on in-flight tool calls, CAQS included", () => {
  clearGeminiThoughtSignatureMemoryForTests();
  storeGeminiThoughtSignature("ns-1:call_foreign", GEMINI_SIGNATURE);
  storeGeminiThoughtSignature("call_foreign", GEMINI_SIGNATURE);
  // A well-formed Claude 5.5 signature the upstream just rejected as stale for this session.
  storeGeminiThoughtSignature("ns-1:call_caqs", NATIVE_SIGNATURE);
  storeGeminiThoughtSignature("call_caqs", NATIVE_SIGNATURE);
  // A call already on the bypass sentinel carries no real signature: its cache entry stays.
  storeGeminiThoughtSignature("call_bypassed", GEMINI_SIGNATURE);

  const body = {
    model: "claude-opus-5-5-high",
    request: {
      contents: [
        {
          role: "model",
          parts: [
            {
              functionCall: { id: "call_foreign", name: "f", args: {} },
              thoughtSignature: GEMINI_SIGNATURE,
            },
            {
              functionCall: { id: "call_caqs", name: "g", args: {} },
              thoughtSignature: NATIVE_SIGNATURE,
            },
            {
              functionCall: { id: "call_bypassed", name: "h", args: {} },
              thoughtSignature: "skip_thought_signature_validator",
            },
          ],
        },
      ],
    },
  };
  const sanitized = sanitizeThinkingSignatures(body, {
    ...CREDS,
    _signatureNamespace: "ns-1",
  } as never);

  assert.equal(getGeminiThoughtSignature("ns-1:call_foreign"), null);
  assert.equal(getGeminiThoughtSignature("call_foreign"), null);
  assert.equal(getGeminiThoughtSignature("ns-1:call_caqs"), null, "namespaced CAQS purged");
  assert.equal(getGeminiThoughtSignature("call_caqs"), null, "bare CAQS purged");
  assert.equal(getGeminiThoughtSignature("call_bypassed"), GEMINI_SIGNATURE);

  // Also verify credentials with connectionId (without explicit _signatureNamespace)
  storeGeminiThoughtSignature("conn-xyz:call_caqs", NATIVE_SIGNATURE);
  sanitizeThinkingSignatures(body, {
    ...CREDS,
    connectionId: "conn-xyz",
  } as never);
  assert.equal(
    getGeminiThoughtSignature("conn-xyz:call_caqs"),
    null,
    "connectionId-namespaced CAQS purged"
  );

  const parts = (sanitized.request as Envelope["request"]).contents[0].parts;
  assert.equal(parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(parts[1].thoughtSignature, "skip_thought_signature_validator");
  assert.notEqual(
    body.request.contents[0].parts[0].thoughtSignature,
    "skip_thought_signature_validator",
    "input not mutated"
  );
  clearGeminiThoughtSignatureMemoryForTests();
});

// ── 7. 404/403 entitlement isolation ─────────────────────────────────────────

test("entitlement: 404/403 on Claude 5.5 is recognized for antigravity and agy only", () => {
  assert.equal(
    isAntigravityClaude55EntitlementFailure(
      "antigravity",
      "claude-opus-5-5-high",
      404,
      "Not found"
    ),
    true
  );
  assert.equal(
    isAntigravityClaude55EntitlementFailure(
      "agy",
      "claude-sonnet-5-5-low",
      403,
      "PERMISSION_DENIED"
    ),
    true
  );
  assert.equal(
    isAntigravityClaude55EntitlementFailure("antigravity", "claude-opus-5-5", 404, ""),
    true
  );
  assert.equal(
    isAntigravityClaude55EntitlementFailure("antigravity", "gemini-3.7-flash-high", 404, ""),
    false
  );
  assert.equal(
    isAntigravityClaude55EntitlementFailure("antigravity", "claude-sonnet-4-6", 403, ""),
    false
  );
  assert.equal(
    isAntigravityClaude55EntitlementFailure("antigravity", "claude-opus-5-5-high", 429, ""),
    false
  );
  assert.equal(
    isAntigravityClaude55EntitlementFailure("openai", "claude-opus-5-5-high", 404, ""),
    false
  );
});

test("entitlement: billing suspension and credits exhaustion stay account-level, not a model lock", () => {
  const accountWide = [
    '{"error":{"message":"Your account has been suspended due to a billing issue."}}',
    "Project suspended: spending limit reached",
    '{"error":{"code":"insufficient_quota","message":"Credits exhausted"}}',
    "Your credit balance is too low to access this model.",
  ];
  for (const text of accountWide) {
    for (const provider of ["antigravity", "agy"]) {
      assert.equal(
        isAntigravityClaude55EntitlementFailure(provider, "claude-opus-5-5-high", 403, text),
        false,
        `${provider}: ${text}`
      );
    }
    const result = checkFallbackError(403, text, 0, "claude-opus-5-5-high", "antigravity");
    assert.notEqual(
      result.cooldownMs,
      ANTIGRAVITY_CLAUDE_55_ENTITLEMENT_COOLDOWN_MS,
      `not treated as a 900s entitlement lock: ${text}`
    );
  }
});

test("entitlement: lockout is model-scoped (900s) and leaves Gemini and sibling models usable", () => {
  clearAllModelLockouts();
  const conn = "conn-claude55-free";
  recordAntigravityClaude55EntitlementLockout("antigravity", conn, "claude-opus-5-5-high", 404);

  assert.equal(isModelLocked("antigravity", conn, "claude-opus-5-5-high"), true);
  assert.equal(isModelLocked("antigravity", conn, "gemini-3.7-flash-high"), false);
  assert.equal(isModelLocked("antigravity", conn, "claude-sonnet-4-6"), false);
  assert.equal(isModelLocked("antigravity", conn, "gemini-pro-agent"), false);
  assert.equal(isModelLocked("antigravity", "conn-other-paid", "claude-opus-5-5-high"), false);

  const info = getModelLockoutInfo("antigravity", conn, "claude-opus-5-5-high");
  assert.ok(info);
  assert.ok(info.remainingMs > ANTIGRAVITY_CLAUDE_55_ENTITLEMENT_COOLDOWN_MS - 5_000);
  assert.ok(info.remainingMs <= ANTIGRAVITY_CLAUDE_55_ENTITLEMENT_COOLDOWN_MS);

  recordAntigravityClaude55EntitlementLockout("agy", conn, "claude-sonnet-5-5-medium", 403);
  assert.equal(isModelLocked("agy", conn, "claude-sonnet-5-5-medium"), true);
  assert.equal(isModelLocked("agy", conn, "gemini-3.7-flash-high"), false);
  clearAllModelLockouts();
});

test("entitlement: checkFallbackError rotates accounts with a 900s model-scoped cooldown", () => {
  for (const status of [403, 404]) {
    const result = checkFallbackError(
      status,
      '{"error":{"message":"Requested entity was not found."}}',
      0,
      "claude-opus-5-5-high",
      "antigravity"
    );
    assert.equal(result.shouldFallback, true);
    assert.equal(result.cooldownMs, ANTIGRAVITY_CLAUDE_55_ENTITLEMENT_COOLDOWN_MS);
    assert.equal(result.permanent, undefined, "never a terminal account state");
    assert.equal(result.skipProviderBreaker, true, "never trips the provider breaker");
  }
});

test("entitlement: executor surfaces a Claude 5.5 404 without burning the fallback host", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ error: { code: 404, message: "Requested entity was not found." } }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof fetch;
  try {
    const result = await executor.execute({
      model: "antigravity/claude-sonnet-5-5-high",
      body: { request: { contents: [{ role: "user", parts: [{ text: "q" }] }] } },
      stream: false,
      credentials: CREDS,
      log: SILENT_LOG,
    } as never);
    assert.equal(calls, 1, "entitlement 404 must not be retried on the second Cloud Code host");
    assert.equal(result.response.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("entitlement: Claude 5.5 locks never widen to family:claude or older Claude models", () => {
  clearAllModelLockouts();
  const conn = "conn-claude55-scope";
  for (const provider of ["antigravity", "agy"]) {
    assert.equal(
      getQuotaScopedModelForProvider(provider, "claude-opus-5-5-high"),
      "claude-opus-5-5-high"
    );
    assert.equal(getQuotaScopeLabelForProvider(provider, "claude-sonnet-5-5-medium"), "model");
    // Claude 4.x keeps its shared family scope.
    assert.equal(getQuotaScopedModelForProvider(provider, "claude-sonnet-4-6"), "family:claude");

    // chatCore's generic 404 path: lockModel(..., "model_not_found").
    lockModel(provider, conn, "claude-opus-5-5-high", "model_not_found", 60_000);
    // A generic 403/quota lock on a 5.5 tier.
    lockModel(provider, conn, "claude-sonnet-5-5-low", "forbidden", 60_000);
    lockModelIfPerModelQuota(provider, conn, "claude-opus-5-5-medium", "quota_exhausted", 60_000);
    recordAntigravityClaude55EntitlementLockout(provider, conn, "claude-sonnet-5-5-high", 404);

    assert.equal(isModelLocked(provider, conn, "claude-opus-5-5-high"), true);
    assert.equal(isModelLocked(provider, conn, "claude-sonnet-5-5-low"), true);
    assert.equal(isModelLocked(provider, conn, "claude-sonnet-5-5-high"), true);
    assert.equal(isModelLocked(provider, conn, "claude-sonnet-4-6"), false);
    assert.equal(isModelLocked(provider, conn, "claude-opus-4-6-thinking"), false);
    assert.equal(isModelLocked(provider, conn, "family:claude"), false);
    assert.equal(isModelLocked(provider, conn, "claude-opus-5-5-low"), false, "other tier");
  }
  clearAllModelLockouts();
});

test("entitlement: an agy/antigravity 403 is never classified FORBIDDEN (no ban)", () => {
  const bodies = [
    "Access denied to this model",
    JSON.stringify({
      error: { code: 403, message: "Permission denied on model", status: "FORBIDDEN" },
    }),
  ];
  for (const provider of ["agy", "antigravity"]) {
    for (const body of bodies) {
      const type = classifyProviderError(403, body, provider);
      assert.notEqual(type, PROVIDER_ERROR_TYPES.FORBIDDEN, `${provider}: ${body}`);
      assert.equal(type, PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR, `${provider}: ${body}`);
    }
    assert.ok(
      isAntigravityClaude55EntitlementFailure(provider, "claude-opus-5-5-high", 403, bodies[0])
    );
  }
});

test("entitlement: a bare-alias lock is keyed by the resolved tier (alias and tier both locked)", () => {
  clearAllModelLockouts();
  const conn = "conn-claude55-alias";
  for (const provider of ["antigravity", "agy"]) {
    recordAntigravityClaude55EntitlementLockout(provider, conn, "claude-opus-5-5", 403);
    assert.equal(isModelLocked(provider, conn, "claude-opus-5-5"), true);
    assert.equal(isModelLocked(provider, conn, "claude-opus-5-5-medium"), true, "resolved tier");
    assert.equal(isModelLocked(provider, conn, "claude-opus-5.5"), true, "dotted alias");
    assert.equal(isModelLocked(provider, conn, `${provider}/claude-opus-5-5-medium`), true);
    assert.equal(isModelLocked(provider, conn, "claude-opus-5-5-high"), false, "other tier");
    assert.equal(isModelLocked(provider, conn, "claude-sonnet-5-5-medium"), false);

    // The reverse: a lock on the tiered id is seen when the selector asks for the alias.
    recordAntigravityClaude55EntitlementLockout(provider, conn, "claude-sonnet-5-5-medium", 404);
    assert.equal(isModelLocked(provider, conn, "claude-sonnet-5-5"), true);
    assert.equal(isModelLocked(provider, conn, "claude-sonnet-5.5-thinking"), true);
  }
  clearAllModelLockouts();
});

test("entitlement: a bare alias dispatched at another tier locks that tier too", () => {
  clearAllModelLockouts();
  const conn = "conn-claude55-dispatch";
  // Bare id + reasoning_effort "high" → the upstream denied `-high`.
  const dispatched = toClaude55TieredModelId(
    "claude-opus-5-5",
    resolveClaude55DispatchTier("claude-opus-5-5", {
      request: { generationConfig: { thinkingConfig: { thinkingLevel: 3 } } },
    })
  );
  assert.equal(dispatched, "claude-opus-5-5-high");
  recordAntigravityClaude55EntitlementLockout(
    "antigravity",
    conn,
    "claude-opus-5-5",
    403,
    dispatched
  );
  assert.equal(isModelLocked("antigravity", conn, "claude-opus-5-5"), true);
  assert.equal(isModelLocked("antigravity", conn, "claude-opus-5-5-medium"), true);
  assert.equal(isModelLocked("antigravity", conn, "claude-opus-5-5-high"), true);
  assert.equal(isModelLocked("antigravity", conn, "claude-opus-5-5-low"), false);
  clearAllModelLockouts();
});

test("entitlement: chatCore skips the OAuth refresh on a Claude 5.5 403 and locks the tier", async () => {
  const core = await import("../../src/lib/db/core.ts");
  assert.equal(core.DATA_DIR, TEST_DATA_DIR, "must not write to the real data dir");
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
  const originalFetch = globalThis.fetch;

  async function run(model: string, connectionId: string) {
    // generateAfterRefresh = chatCore's same-account retry with the refreshed token.
    // (The executor's own one-shot 403 retry without x-goog-user-project still uses
    // the original token, so it is not counted there.)
    const calls = { token: 0, generateAfterRefresh: 0 };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(OAUTH_ENDPOINTS.google.token)) {
        calls.token++;
        return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (new Headers(init?.headers).get("authorization") === "Bearer refreshed-token") {
        calls.generateAfterRefresh++;
      }
      return new Response(
        JSON.stringify({
          error: { code: 403, message: "Permission denied on model", status: "PERMISSION_DENIED" },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
    const body = { model, messages: [{ role: "user", content: "hi" }], stream: false };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "antigravity", model, extendedContext: false },
      credentials: {
        connectionId,
        accessToken: "token",
        refreshToken: "refresh-token",
        projectId: "project-1",
        providerSpecificData: {},
      },
      log: SILENT_LOG,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
    } as never);
    return { calls, result };
  }

  try {
    clearAllModelLockouts();
    const denied = await run("claude-opus-5-5", "conn-claude55-chatcore");
    assert.equal(denied.calls.token, 0, "no OAuth refresh for a Claude 5.5 entitlement 403");
    assert.equal(
      denied.calls.generateAfterRefresh,
      0,
      "the denied request is not repeated on this account after a refresh"
    );
    assert.equal(denied.result.success, false);
    assert.equal(denied.result.status, 403);
    assert.equal(isModelLocked("antigravity", "conn-claude55-chatcore", "claude-opus-5-5"), true);
    assert.equal(
      isModelLocked("antigravity", "conn-claude55-chatcore", "claude-opus-5-5-medium"),
      true
    );

    // Control: the same 403 on an older Claude still goes through the refresh path.
    const legacy = await run("claude-sonnet-4-6", "conn-claude4-chatcore");
    assert.ok(legacy.calls.token >= 1, "non-5.5 403 still attempts the OAuth refresh");
    assert.ok(legacy.calls.generateAfterRefresh >= 1, "refresh then a same-account retry");
  } finally {
    globalThis.fetch = originalFetch;
    clearAllModelLockouts();
    // Let fire-and-forget call-log / usage writes land before the DB is closed.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    core.resetDbInstance();
  }
});

test("normalization: explicit Claude 5.5 tiers are preserved for antigravity and agy", () => {
  for (const provider of ["antigravity", "agy"]) {
    for (const model of [
      "claude-opus-5-5-high",
      "claude-sonnet-5-5-low",
      "claude-opus-5-5-medium",
    ]) {
      const body = { reasoning_effort: "low", model };
      const normalized = applyClaudeEffortVariant({
        provider,
        effectiveModel: model,
        body,
        sourceFormat: "openai",
      });
      assert.equal(normalized.effectiveModel, model, `tier must not be stripped for ${provider}`);
      assert.equal(body.model, model, `body.model must remain ${model}`);
    }
  }

  // Control: non-antigravity lane still strips effort suffix
  const control = applyClaudeEffortVariant({
    provider: "claude",
    effectiveModel: "claude-opus-5-5-high",
    body: { model: "claude-opus-5-5-high" },
    sourceFormat: "openai",
  });
  assert.equal(control.effectiveModel, "claude-opus-5-5");
});

test("entitlement: markAccountUnavailable honors dispatchedModel for Claude 5.5", async () => {
  clearAllModelLockouts();
  const conn = "conn-claude55-mark-dispatched";
  for (const provider of ["antigravity", "agy"]) {
    await markAccountUnavailable(
      conn,
      403,
      "Permission denied",
      provider,
      "claude-opus-5-5",
      null,
      { dispatchedModel: "claude-opus-5-5-high" }
    );
    assert.equal(isModelLocked(provider, conn, "claude-opus-5-5"), true);
    assert.equal(
      isModelLocked(provider, conn, "claude-opus-5-5-medium"),
      true,
      "medium tier alias"
    );
    assert.equal(
      isModelLocked(provider, conn, "claude-opus-5-5-high"),
      true,
      "dispatched high tier"
    );
    assert.equal(isModelLocked(provider, conn, "claude-opus-5-5-low"), false, "low tier unlocked");
  }
  clearAllModelLockouts();
});
