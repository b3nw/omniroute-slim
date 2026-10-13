import test from "node:test";
import assert from "node:assert/strict";

import {
  getConnectionAllowedModels,
  getConnectionExcludedModels,
  hasEligibleConnectionForModel,
  isModelAllowedByConnection,
  isModelExcludedByConnection,
  normalizeAllowedModelPatterns,
  normalizeExcludedModelPatterns,
} from "../../src/domain/connectionModelRules.ts";

test("normalizeExcludedModelPatterns accepts arrays and CSV strings, trims values, and removes duplicates", () => {
  assert.deepEqual(normalizeExcludedModelPatterns([" gpt-4o* ", "gpt-4o*", "", "**"]), ["gpt-4o*"]);
  assert.deepEqual(normalizeExcludedModelPatterns("gpt-4.1*, gpt-4o*, gpt-4.1*"), [
    "gpt-4.1*",
    "gpt-4o*",
  ]);
});

test("isModelExcludedByConnection matches both provider-scoped and raw model ids", () => {
  const providerSpecificData = {
    excludedModels: ["gpt-4o*", "claude-opus-*"],
  };

  assert.equal(isModelExcludedByConnection("openai/gpt-4o-mini", providerSpecificData), true);
  assert.equal(isModelExcludedByConnection("gpt-4o-mini", providerSpecificData), true);
  assert.equal(isModelExcludedByConnection("claude-sonnet-4-5", providerSpecificData), false);
});

test("hasEligibleConnectionForModel only returns true when at least one connection can serve the model", () => {
  const connections = [
    { providerSpecificData: { excludedModels: ["gpt-4o*"] } },
    { providerSpecificData: { excludedModels: ["gpt-4.1*"] } },
  ];

  assert.equal(hasEligibleConnectionForModel(connections, "gpt-4o-mini"), true);
  assert.equal(
    hasEligibleConnectionForModel(
      [
        { providerSpecificData: { excludedModels: ["gpt-4o*"] } },
        { providerSpecificData: { excludedModels: ["gpt-4o-mini"] } },
      ],
      "gpt-4o-mini"
    ),
    false
  );
  assert.deepEqual(getConnectionExcludedModels({ excluded_models: ["gpt-4o*"] }), ["gpt-4o*"]);
});

test("isModelAllowedByConnection is open by default when allowedModels is absent or empty", () => {
  for (const providerSpecificData of [
    undefined,
    null,
    {},
    { allowedModels: undefined },
    { allowedModels: null },
    { allowedModels: [] },
    { allowedModels: "" },
    { allowedModels: " , ," },
    { allowedModels: ["**"] },
  ]) {
    assert.equal(
      isModelAllowedByConnection("gpt-4o-mini", providerSpecificData),
      true,
      JSON.stringify(providerSpecificData)
    );
  }
  assert.deepEqual(getConnectionAllowedModels({ allowedModels: [] }), []);
});

test("isModelAllowedByConnection only permits models matching exact or wildcard patterns", () => {
  const providerSpecificData = { allowedModels: ["gpt-6.1-sol", "gpt-5*"] };

  assert.equal(isModelAllowedByConnection("gpt-6.1-sol", providerSpecificData), true);
  assert.equal(isModelAllowedByConnection("gpt-5-mini", providerSpecificData), true);
  assert.equal(isModelAllowedByConnection("openai/gpt-5.2", providerSpecificData), true);
  assert.equal(isModelAllowedByConnection("GPT-5-MINI", providerSpecificData), true);
  assert.equal(isModelAllowedByConnection("gpt-5[1m]", providerSpecificData), true);
  assert.equal(isModelAllowedByConnection("gpt-6.1", providerSpecificData), false);
  assert.equal(isModelAllowedByConnection("gpt-4o", providerSpecificData), false);
  assert.equal(isModelAllowedByConnection("claude-opus-4-5", providerSpecificData), false);
});

test("isModelAllowedByConnection accepts CSV strings and the snake_case alias", () => {
  assert.equal(
    isModelAllowedByConnection("claude-sonnet-4-5", { allowedModels: "gpt-5*, claude-*" }),
    true
  );
  assert.equal(
    isModelAllowedByConnection("gemini-2.5-pro", { allowedModels: "gpt-5*, claude-*" }),
    false
  );
  assert.equal(
    isModelAllowedByConnection("gemini-2.5-pro", { allowed_models: ["gemini-*"] }),
    true
  );
  assert.equal(isModelAllowedByConnection("gpt-5", { allowed_models: ["gemini-*"] }), false);
  assert.deepEqual(getConnectionAllowedModels({ allowed_models: " a*, b ,a*" }), ["a*", "b"]);
  assert.deepEqual(normalizeAllowedModelPatterns([" x ", "x", "", "**", 5]), ["x"]);
});

test("isModelAllowedByConnection: excludedModels takes precedence over allowedModels", () => {
  const providerSpecificData = { allowedModels: ["gpt-5*"], excludedModels: ["gpt-5-pro*"] };

  assert.equal(isModelAllowedByConnection("gpt-5-mini", providerSpecificData), true);
  assert.equal(isModelAllowedByConnection("gpt-5-pro", providerSpecificData), false);
  assert.equal(isModelAllowedByConnection("gpt-5-pro-high", providerSpecificData), false);
  // denylist still applies with no allowlist configured
  assert.equal(isModelAllowedByConnection("gpt-5-pro", { excludedModels: ["gpt-5-pro"] }), false);
});

test("isModelAllowedByConnection does not reject an empty/non-string model id", () => {
  assert.equal(isModelAllowedByConnection("", { allowedModels: ["gpt-5*"] }), true);
  assert.equal(isModelAllowedByConnection(undefined, { allowedModels: ["gpt-5*"] }), true);
});

test("hasEligibleConnectionForModel honours allowedModels and the excludedModels precedence", () => {
  assert.equal(
    hasEligibleConnectionForModel(
      [
        { providerSpecificData: { allowedModels: ["claude-*"] } },
        { providerSpecificData: { allowedModels: ["gpt-5*"], excludedModels: ["gpt-5-pro"] } },
      ],
      "gpt-5-pro"
    ),
    false
  );
  assert.equal(
    hasEligibleConnectionForModel(
      [
        { providerSpecificData: { allowedModels: ["claude-*"] } },
        { providerSpecificData: { allowedModels: ["gpt-5*"] } },
      ],
      "gpt-5-mini"
    ),
    true
  );
  assert.equal(
    hasEligibleConnectionForModel(
      [{ providerSpecificData: { allowedModels: ["claude-*"] } }, { providerSpecificData: {} }],
      "gpt-4o"
    ),
    true
  );
});
