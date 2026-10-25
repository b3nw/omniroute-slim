// Phase A flagship catalog ceilings: Claude Opus 5.5 (1M context, 5 effort tiers,
// Fast Mode) and GPT-6 Sol/Luna (1.05M context).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// calculateCost lazily opens the pricing DB; isolate it before that happens.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-phase-a-flagship-"));
process.env.DATA_DIR = TEST_DATA_DIR;

import { MODEL_SPECS, getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import {
  CLAUDE_FAST_MODE_DEFAULT_MODELS,
  CPA_FORCE_FAST_MODE_HEADER,
  getClaudeFastModeSupportedModels,
  shouldRequestClaudeFastMode,
} from "../../src/lib/providers/claudeFastMode.ts";

const core = await import("../../src/lib/db/core.ts");
const { calculateCost } = await import("../../src/lib/usage/costCalculator.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

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

test("MODEL_SPECS: dated Claude Opus 5.5 ids resolve to Opus 5.5, not Opus 5", () => {
  assert.equal(getModelSpec(`${OPUS_55}-20261001`), MODEL_SPECS[OPUS_55]);
  assert.equal(getModelSpec("claude-opus-5-20260101"), MODEL_SPECS["claude-opus-5"]);
});

test("calculateCost: Codex GPT-6 Sol/Luna and effort variants are priced", async () => {
  const tokens = { input: 1000, output: 500 };
  // Sol: 1000 × $5/M + 500 × $30/M; Luna: 1000 × $1/M + 500 × $6/M.
  const cases = [
    ["gpt-6-sol", 0.02],
    ["gpt-6-sol-ultra", 0.02],
    ["gpt-6-sol-xhigh", 0.02],
    ["gpt-6-sol-low", 0.02],
    ["gpt-6-luna", 0.004],
    ["gpt-6-luna-max", 0.004],
    ["gpt-6-luna-medium", 0.004],
    // Not a catalog row: falls back to the effortless base via suffix stripping.
    ["gpt-6-luna-ultra", 0.004],
  ] as const;
  for (const provider of ["codex", "cx"]) {
    for (const [model, expected] of cases) {
      const cost = await calculateCost(provider, model, tokens);
      assert.ok(
        Math.abs(cost - expected) < 1e-12,
        `${provider}/${model}: expected ${expected}, got ${cost}`
      );
    }
  }
});
