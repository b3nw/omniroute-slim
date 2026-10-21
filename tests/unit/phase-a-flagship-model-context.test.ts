// Phase A flagship catalog ceilings: Claude Opus 5.5 (1M context, 5 effort tiers,
// Fast Mode) and GPT-6 Sol/Luna (1.05M context).
import test from "node:test";
import assert from "node:assert/strict";

import { MODEL_SPECS, getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import {
  CLAUDE_FAST_MODE_DEFAULT_MODELS,
  CPA_FORCE_FAST_MODE_HEADER,
  getClaudeFastModeSupportedModels,
  shouldRequestClaudeFastMode,
} from "../../src/lib/providers/claudeFastMode.ts";

const OPUS_55 = "claude-opus-5-5";
const OPUS_55_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

test("MODEL_SPECS: Claude Opus 5.5 has a 1,000,000-token context window", () => {
  const spec = MODEL_SPECS[OPUS_55];
  assert.ok(spec, "claude-opus-5-5 must be present in MODEL_SPECS");
  assert.equal(spec.contextWindow, 1_000_000);
  assert.equal(spec.maxOutputTokens, 128_000);
  assert.equal(getModelSpec(`anthropic.${OPUS_55}`), spec, "Bedrock alias resolves to the spec");
});

test("MODEL_SPECS: GPT-6 Sol and Luna have a 1,050,000-token context window", () => {
  for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
    const spec = MODEL_SPECS[id];
    assert.ok(spec, `${id} must be present in MODEL_SPECS`);
    assert.equal(spec.contextWindow, 1_050_000, `${id} context window`);
    assert.equal(getModelSpec(`openai/${id}`), spec, `${id} openai/ alias resolves`);
  }
});

test("Claude Opus 5.5 exposes the 5 effort tiers on every launch surface", () => {
  for (const [providerId, modelId] of [
    ["anthropic", OPUS_55],
    ["claude", OPUS_55],
    ["bedrock", `anthropic.${OPUS_55}`],
  ] as const) {
    const model = getModelsByProviderId(providerId).find((entry) => entry.id === modelId);
    assert.ok(model, `${providerId}/${modelId} must be registered`);
    assert.deepEqual(
      [...(model.supportedThinkingEfforts ?? [])],
      OPUS_55_EFFORTS,
      `${providerId} effort tiers`
    );
    assert.equal(model.supportsXHighEffort, true, `${providerId} accepts xhigh natively`);
    assert.equal(model.contextLength, 1_000_000, `${providerId} context window`);
  }
});

test("Claude Fast Mode passthrough is exposed for Opus 5.5", () => {
  assert.ok((CLAUDE_FAST_MODE_DEFAULT_MODELS as readonly string[]).includes(OPUS_55));
  assert.ok(getClaudeFastModeSupportedModels({}).includes(OPUS_55));
  assert.equal(CPA_FORCE_FAST_MODE_HEADER, "X-CPA-Force-Fast-Mode");

  const enabled = { claudeFastMode: { enabled: true } };
  assert.equal(shouldRequestClaudeFastMode(enabled, OPUS_55), true);
  assert.equal(shouldRequestClaudeFastMode(enabled, `${OPUS_55}-20261001`), true);
  assert.equal(shouldRequestClaudeFastMode({ claudeFastMode: false }, OPUS_55), false);
  assert.equal(shouldRequestClaudeFastMode(enabled, "claude-sonnet-5"), false);
});
