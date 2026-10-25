import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { splitCodexReasoningSuffix } from "../../open-sse/executors/codex/reasoningSuffix.ts";
import { CODEX_NATIVE_UNPREFIXED_MODELS } from "../../open-sse/services/model.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import {
  buildCodexModelsUrl,
  normalizeCodexGithubCatalogResponse,
} from "../../src/app/api/providers/[id]/models/discovery/codex.ts";

const GPT6_BASE_MODELS = ["gpt-6-sol", "gpt-6-luna"] as const;

test("Codex discovery requests the catalog as a client new enough for GPT-6", () => {
  assert.equal(
    buildCodexModelsUrl(),
    "https://chatgpt.com/backend-api/codex/models?client_version=0.159.2"
  );
});

test("Codex discovery imports GPT-6 models gated on minimal_client_version", () => {
  const parsed = normalizeCodexGithubCatalogResponse({
    models: [
      {
        slug: "gpt-6-luna",
        display_name: "GPT-6-Luna",
        visibility: "list",
        supported_in_api: true,
        minimal_client_version: "0.155.0",
      },
      {
        slug: "gpt-6-sol",
        display_name: "GPT-6-Sol",
        visibility: "list",
        supported_in_api: true,
        minimal_client_version: "0.155.0",
      },
      {
        slug: "future-model",
        display_name: "Future Model",
        visibility: "list",
        supported_in_api: true,
        minimal_client_version: "0.160.0",
      },
    ],
  });

  assert.deepEqual(parsed.map((model) => model.id).sort(), [
    "gpt-6-luna",
    "gpt-6-sol",
  ]);
});

test("Codex static catalog exposes the GPT-6 lineup with 272K/32K limits", () => {
  const models = getModelsByProviderId("codex");
  const expectedIds = [
    "gpt-6-sol",
    "gpt-6-sol-ultra",
    "gpt-6-sol-max",
    "gpt-6-sol-xhigh",
    "gpt-6-sol-high",
    "gpt-6-sol-medium",
    "gpt-6-sol-low",
    "gpt-6-luna",
    "gpt-6-luna-max",
    "gpt-6-luna-xhigh",
    "gpt-6-luna-high",
    "gpt-6-luna-medium",
    "gpt-6-luna-low",
  ];

  for (const modelId of expectedIds) {
    const model = models.find((entry) => entry.id === modelId);
    assert.ok(model, `codex must expose ${modelId}`);
    assert.equal(model.contextLength, 272000);
    assert.equal(model.maxInputTokens, 272000);
    assert.equal(model.maxOutputTokens, 32768);
    assert.equal(model.targetFormat, "openai-responses");
    assert.equal(model.toolCalling, true);
    assert.equal(model.supportsReasoning, true);
    assert.equal(model.supportsVision, true);
  }

  assert.equal(
    models.some((model) => model.id === "gpt-6-luna-ultra"),
    false
  );
});

test("bare GPT-6 ids are native Codex models", () => {
  for (const modelId of GPT6_BASE_MODELS) {
    assert.ok(CODEX_NATIVE_UNPREFIXED_MODELS.has(modelId), modelId);
  }
  assert.ok(CODEX_NATIVE_UNPREFIXED_MODELS.has("gpt-6-sol-ultra"));
  assert.ok(CODEX_NATIVE_UNPREFIXED_MODELS.has("gpt-6-luna-max"));
});

test("splitCodexReasoningSuffix recognizes GPT-6 max/ultra aliases", () => {
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-sol-ultra"), {
    baseModel: "gpt-6-sol",
    effort: "ultra",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-sol-max"), {
    baseModel: "gpt-6-sol",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna-max"), {
    baseModel: "gpt-6-luna",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna(max)"), {
    baseModel: "gpt-6-luna",
    effort: "max",
  });
  // Luna has no ultra tier: the hyphen alias is not split as a reasoning suffix.
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna-ultra"), {
    baseModel: "gpt-6-luna-ultra",
    effort: null,
  });
});

test("CodexExecutor.transformRequest strips GPT-6 aliases and keeps their effort", () => {
  const executor = new CodexExecutor();
  const cases = [
    { model: "gpt-6-sol-ultra", expectedModel: "gpt-6-sol", expectedEffort: "max" },
    { model: "gpt-6-sol-max", expectedModel: "gpt-6-sol", expectedEffort: "max" },
    { model: "gpt-6-luna-max", expectedModel: "gpt-6-luna", expectedEffort: "max" },
    { model: "gpt-6-luna(ultra)", expectedModel: "gpt-6-luna", expectedEffort: "max" },
  ];

  for (const { model, expectedModel, expectedEffort } of cases) {
    const result = executor.transformRequest(model, { model, input: [] }, false, {
      requestEndpointPath: "/responses",
    });
    assert.equal(result.model, expectedModel, model);
    assert.equal(result.reasoning.effort, expectedEffort, model);
  }
});

test("CodexExecutor.transformRequest clamps GPT-6 effort to each model's cap", () => {
  const executor = new CodexExecutor();
  const cases = [
    { model: "gpt-6-sol", requested: "ultra", expectedEffort: "max" },
    { model: "gpt-6-luna", requested: "ultra", expectedEffort: "max" },
    { model: "gpt-6-luna", requested: "max", expectedEffort: "max" },
  ];

  for (const { model, requested, expectedEffort } of cases) {
    const result = executor.transformRequest(
      model,
      { model, input: [], reasoning_effort: requested },
      false,
      { requestEndpointPath: "/responses" }
    );
    assert.equal(result.model, model);
    assert.equal(result.reasoning.effort, expectedEffort, `${model}@${requested}`);
  }
});

test("Chat-to-Codex translation preserves max for GPT-6 Sol/Luna", () => {
  const executor = new CodexExecutor();
  const cases = [
    { model: "gpt-6-sol", expectedEffort: "max" },
    { model: "gpt-6-luna", expectedEffort: "max" },
  ];

  for (const { model, expectedEffort } of cases) {
    const translated = openaiToOpenAIResponsesRequest(
      model,
      { model, messages: [{ role: "user", content: "test" }], reasoning_effort: "max" },
      true,
      {}
    );
    const result = executor.transformRequest(model, translated, true, {
      requestEndpointPath: "/chat/completions",
    });
    assert.equal(result.model, model);
    assert.equal(result.reasoning.effort, expectedEffort, model);
  }
});
