import test from "node:test";
import assert from "node:assert/strict";

import { ANTIGRAVITY_MODEL_ALIASES } from "../../open-sse/config/antigravityModelAliases.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";

// The translator reads getModelSpec() on the caller-facing id, before the executor
// resolves ANTIGRAVITY_MODEL_ALIASES. A bare alias without its own spec falls through
// to the "unknown model" path: an uncapped 32768 thinking budget and no output limit.
const TIERED_CAP = 24576;
const BARE_AND_TIER_IDS = [
  ["gemini-3.8-flash", 65536],
  ["gemini-3.8-flash-high", 65536],
  ["gemini-3.8-flash-medium", 65536],
  ["gemini-3.8-flash-low", 65536],
  ["gemini-4-argon", 65535],
  ["gemini-4-argon-high", 65535],
  ["gemini-4-argon-medium", 65535],
  ["gemini-4-argon-low", 65535],
] as const;

function translateHigh(model: string) {
  const result = openaiToAntigravityRequest(
    model,
    { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
    false,
    { projectId: "project-1" } as any
  ) as any;
  return result.request.generationConfig;
}

test("gemini-3.8-flash bare alias has the tiered spec limits", () => {
  const spec = getModelSpec("gemini-3.8-flash");
  assert.ok(spec, "gemini-3.8-flash must resolve to a model spec");
  assert.equal(spec.thinkingBudgetCap, TIERED_CAP);
  assert.equal(spec.maxOutputTokens, 65536);
  assert.equal(spec.defaultThinkingBudget, getModelSpec("gemini-3.8-flash-tiered")?.defaultThinkingBudget);
});

for (const [id, maxOut] of BARE_AND_TIER_IDS) {
  test(`${id} is capped at ${TIERED_CAP} for reasoning_effort=high`, () => {
    assert.equal(getModelSpec(id)?.thinkingBudgetCap, TIERED_CAP);
    const generationConfig = translateHigh(id);
    assert.ok(generationConfig.thinkingConfig.thinkingBudget <= TIERED_CAP);
    assert.equal(generationConfig.maxOutputTokens, maxOut);
  });
}

test("every 3.8 Flash / Argon alias key receives the same budget as its target", () => {
  for (const [alias, target] of Object.entries(ANTIGRAVITY_MODEL_ALIASES)) {
    if (!/^gemini-(3\.8-flash|4-argon)/.test(alias)) continue;
    assert.deepEqual(
      translateHigh(alias).thinkingConfig,
      translateHigh(target).thinkingConfig,
      `${alias} -> ${target}`
    );
  }
});
