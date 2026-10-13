import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  assignEditApiKeyProviderSpecificData,
  buildAddProviderSpecificData,
} from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/connectionProviderSpecificData.ts";
import {
  formatAllowedModelsInput,
  parseAllowedModelsInput,
} from "../../../src/app/(dashboard)/dashboard/providers/[id]/providerInputParsers.ts";
import { normalizeProviderSpecificData } from "../../../src/lib/providers/requestDefaults.ts";
import { validateProviderSpecificData } from "../../../src/shared/validation/providerSpecificData.ts";

const BASE_FORM_DATA = {
  accountId: "",
  allowedModels: "",
  apiRegion: "international",
  ccCompatibleContext1m: false,
  ccCompatibleRedactThinking: false,
  ccCompatibleSummarizeThinking: false,
  consoleApiKey: "",
  customUserAgent: "",
  cx: "",
  excludedModels: "",
  glmOrganizationId: "",
  glmProjectId: "",
  importFreeModelsOnly: false,
  m365Tier: undefined,
  newApiAggregatorBalance: false,
  newApiUserId: "",
  ollamaCloudUsageCookie: "",
  opencodeGoAuthCookie: "",
  opencodeGoWorkspaceId: "",
  passthroughModels: false,
  quotaPerUnit: "",
  region: "",
  routingTags: "",
  tag: "",
  validationModelId: undefined,
  tunnelId: "",
  connectorName: "",
};

function addOptions(formData: typeof BASE_FORM_DATA) {
  return {
    provider: "openai",
    formData,
    openRouterPreset: { applyTo: () => {} },
    showFreeModelsToggle: false,
    isGooglePse: false,
    usesBaseUrl: false,
    validatedBaseUrl: null,
    showsRegion: false,
    defaultRegion: "us-central1",
    isGlm: false,
    isCloudflare: false,
  };
}

function editOptions(formData: typeof BASE_FORM_DATA, target: Record<string, unknown>) {
  return {
    provider: "openai",
    formData,
    target,
    extraApiKeys: [],
    openRouterPreset: { getPatch: () => ({}) },
    usesBaseUrl: false,
    validatedBaseUrl: null,
    showsRegion: false,
    defaultRegion: "us-central1",
    isGlm: false,
    isCloudflare: false,
    isAntigravityFamily: false,
    trimmedCloudCodeProjectId: "",
    isGooglePse: false,
    isCcCompatible: false,
  };
}

function validationIssues(data: Record<string, unknown>) {
  const result = z
    .record(z.string(), z.unknown())
    .superRefine((value, ctx) => validateProviderSpecificData(value, ctx))
    .safeParse(data);
  return result.success ? [] : result.error.issues;
}

test("parseAllowedModelsInput trims, dedupes, and returns undefined when empty", () => {
  assert.deepEqual(parseAllowedModelsInput(" gpt-6.1-sol , gpt-5*, gpt-5* ,"), [
    "gpt-6.1-sol",
    "gpt-5*",
  ]);
  assert.equal(parseAllowedModelsInput(""), undefined);
  assert.equal(parseAllowedModelsInput(" , "), undefined);
});

test("formatAllowedModelsInput joins arrays and tolerates legacy CSV strings", () => {
  assert.equal(formatAllowedModelsInput(["gpt-5*", "", 3, "claude-*"]), "gpt-5*, claude-*");
  assert.equal(formatAllowedModelsInput(" gpt-5*, claude-* "), "gpt-5*, claude-*");
  assert.equal(formatAllowedModelsInput(undefined), "");
  assert.equal(formatAllowedModelsInput(null), "");
});

test("buildAddProviderSpecificData persists allowedModels only when provided", () => {
  const data = buildAddProviderSpecificData(
    addOptions({ ...BASE_FORM_DATA, allowedModels: "gpt-5*, gpt-6.1-sol" })
  );
  assert.deepEqual(data?.allowedModels, ["gpt-5*", "gpt-6.1-sol"]);

  const empty = buildAddProviderSpecificData(addOptions(BASE_FORM_DATA));
  assert.equal(empty?.allowedModels, undefined);
});

test("assignEditApiKeyProviderSpecificData sets and clears allowedModels", () => {
  const target: Record<string, unknown> = { allowedModels: ["old-*"] };
  assignEditApiKeyProviderSpecificData(
    editOptions({ ...BASE_FORM_DATA, allowedModels: "gpt-5*" }, target)
  );
  assert.deepEqual(target.allowedModels, ["gpt-5*"]);

  assignEditApiKeyProviderSpecificData(editOptions(BASE_FORM_DATA, target));
  assert.deepEqual(target.allowedModels, []);
});

test("normalizeProviderSpecificData canonicalises allowedModels / allowed_models", () => {
  assert.deepEqual(
    normalizeProviderSpecificData("openai", { allowed_models: " gpt-5*, claude-*, gpt-5* " }),
    { allowedModels: ["gpt-5*", "claude-*"] }
  );
  assert.deepEqual(
    normalizeProviderSpecificData("openai", { allowedModels: ["a*"], allowed_models: ["b*"] }),
    { allowedModels: ["a*"] }
  );
  const cleared = normalizeProviderSpecificData("openai", { allowedModels: [], tag: "x" });
  assert.equal(cleared && "allowedModels" in cleared, false);
  const clearedCsv = normalizeProviderSpecificData("openai", { allowedModels: " , ", tag: "x" });
  assert.equal(clearedCsv && "allowedModels" in clearedCsv, false);
});

test("validateProviderSpecificData enforces allowedModels limits like excludedModels", () => {
  assert.deepEqual(validationIssues({ allowedModels: ["gpt-5*"] }), []);
  assert.deepEqual(validationIssues({ allowedModels: "gpt-5*, claude-*" }), []);
  assert.deepEqual(validationIssues({ allowedModels: null }), []);

  const tooLongString = validationIssues({ allowedModels: "x".repeat(5001) });
  assert.equal(tooLongString.length, 1);
  assert.deepEqual(tooLongString[0].path, ["allowedModels"]);

  const tooMany = validationIssues({
    allowedModels: Array.from({ length: 101 }, (_, i) => `m-${i}`),
  });
  assert.equal(tooMany.length, 1);
  assert.match(tooMany[0].message, /allowedModels must be an array with at most 100 items/);

  assert.equal(validationIssues({ allowedModels: ["x".repeat(201)] }).length, 1);
  assert.equal(validationIssues({ allowedModels: [""] }).length, 1);
  assert.equal(validationIssues({ allowedModels: 42 }).length, 1);
  assert.equal(validationIssues({ allowed_models: ["x".repeat(201)] }).length, 1);

  // excludedModels validation is unchanged by the shared helper
  assert.equal(validationIssues({ excludedModels: ["**"] }).length, 1);
  assert.match(
    validationIssues({ excludedModels: 42 })[0].message,
    /excludedModels must be an array/
  );
});
