import test from "node:test";
import assert from "node:assert/strict";

const { applyFingerprint, isCliCompatEnabled, setCliCompatProviders } = await import(
  "../../open-sse/config/cliFingerprints.ts"
);
const { normalizeCliCompatProviderId } = await import("../../src/shared/utils/cliCompat.ts");
const { IMPLEMENTED_CLI_FINGERPRINT_PROVIDER_IDS } = await import(
  "../../src/shared/constants/cliCompatProviders.ts"
);

test("Codex CLI fingerprint orders prompt_cache_key before include", () => {
  const body = {
    model: "gpt-5.5-low",
    stream: true,
    input: [{ role: "user", content: "hello" }],
    instructions: "You are Codex.",
    store: false,
    reasoning: { effort: "low" },
    tools: [],
    tool_choice: "auto",
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "conv-codex",
    service_tier: "priority",
  };

  const result = applyFingerprint("codex", {}, body);
  const orderedKeys = Object.keys(JSON.parse(result.bodyString));

  assert.deepEqual(orderedKeys.slice(0, 10), [
    "model",
    "stream",
    "input",
    "instructions",
    "store",
    "reasoning",
    "prompt_cache_key",
    "tools",
    "tool_choice",
    "include",
  ]);
});

test("Gemini CLI fingerprint normalizes gemini_cli alias, enables compat by default, and orders headers & nested request keys", () => {
  assert.equal(normalizeCliCompatProviderId("gemini-cli"), "gemini-cli");
  assert.equal(normalizeCliCompatProviderId("gemini_cli"), "gemini-cli");
  assert.equal(isCliCompatEnabled("gemini-cli"), true);
  assert.equal(isCliCompatEnabled("gemini_cli"), true);

  const unorderedHeaders = {
    Authorization: "Bearer ya29.test",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "X-Goog-Api-Client": "gl-node/22.17.1",
    "User-Agent": "GeminiCLI/0.66.0/gemini-3-flash (linux; x64; terminal) google-api-nodejs-client/10.9.0",
    "Content-Type": "application/json",
  };

  const unorderedBody = {
    enabled_credit_types: ["GOOGLE_ONE_CREDIT"],
    request: {
      session_id: "sess-1",
      generationConfig: { temperature: 1 },
      safetySettings: [],
      labels: { env: "prod" },
      toolConfig: {},
      tools: [{ functionDeclarations: [] }],
      cachedContent: "cache-1",
      systemInstruction: { role: "user", parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      _omnirouteInnerMarker: "strip-me",
    },
    user_prompt_id: "sess-1",
    project: "proj-1",
    model: "gemini-3-flash",
    _omnirouteTopMarker: "strip-me",
  };

  for (const providerId of ["gemini-cli", "gemini_cli"]) {
    const result = applyFingerprint(
      providerId,
      { ...unorderedHeaders },
      structuredClone(unorderedBody)
    );

    assert.deepEqual(Object.keys(result.headers), [
      "Content-Type",
      "User-Agent",
      "X-Goog-Api-Client",
      "Accept",
      "Accept-Encoding",
      "Authorization",
    ]);

    const parsed = JSON.parse(result.bodyString);
    assert.equal(parsed._omnirouteTopMarker, undefined);
    assert.equal(parsed.request._omnirouteInnerMarker, undefined);
    assert.deepEqual(Object.keys(parsed), [
      "model",
      "project",
      "user_prompt_id",
      "request",
      "enabled_credit_types",
    ]);
    assert.deepEqual(Object.keys(parsed.request), [
      "contents",
      "systemInstruction",
      "cachedContent",
      "tools",
      "toolConfig",
      "labels",
      "safetySettings",
      "generationConfig",
      "session_id",
    ]);
  }

  assert.equal(IMPLEMENTED_CLI_FINGERPRINT_PROVIDER_IDS.includes("gemini-cli"), true);

  // Verify applyFingerprint does not mutate caller-owned body or body.request in place
  const callerBody = {
    model: "gemini-3-flash",
    _omnirouteTopMarker: "preserve-on-caller",
    request: {
      contents: [],
      _omnirouteInnerMarker: "preserve-on-caller",
    },
  };
  applyFingerprint("gemini-cli", { ...unorderedHeaders }, callerBody);
  assert.equal(callerBody._omnirouteTopMarker, "preserve-on-caller");
  assert.equal(callerBody.request._omnirouteInnerMarker, "preserve-on-caller");

  // Verify countTokens inner request orders ["model", "contents"] and x-goog-user-project precedes Authorization
  const countTokensResult = applyFingerprint(
    "gemini-cli",
    {
      ...unorderedHeaders,
      "x-goog-user-project": "adc-quota-proj",
    },
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        model: "models/gemini-3-flash",
      },
    }
  );
  assert.deepEqual(Object.keys(countTokensResult.headers), [
    "Content-Type",
    "User-Agent",
    "X-Goog-Api-Client",
    "Accept",
    "Accept-Encoding",
    "x-goog-user-project",
    "Authorization",
  ]);
  const parsedCountTokens = JSON.parse(countTokensResult.bodyString);
  assert.deepEqual(Object.keys(parsedCountTokens.request), ["model", "contents"]);

  // Also orders ["model", "contents"] when top-level model is present alongside request.model
  const countTokensWithTopModel = applyFingerprint(
    "gemini-cli",
    { ...unorderedHeaders },
    {
      model: "gemini-3-flash",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        model: "models/gemini-3-flash",
      },
    }
  );
  assert.deepEqual(Object.keys(JSON.parse(countTokensWithTopModel.bodyString).request), [
    "model",
    "contents",
  ]);

  // Verify setCliCompatProviders runtime toggles for gemini-cli / gemini_cli
  try {
    setCliCompatProviders([]);
    assert.equal(isCliCompatEnabled("gemini-cli"), false);
    assert.equal(isCliCompatEnabled("gemini_cli"), false);

    setCliCompatProviders(["gemini_cli"]);
    assert.equal(isCliCompatEnabled("gemini-cli"), true);
    assert.equal(isCliCompatEnabled("gemini_cli"), true);
  } finally {
    setCliCompatProviders(null);
  }
  assert.equal(isCliCompatEnabled("gemini-cli"), true);
});
