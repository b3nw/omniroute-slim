import test from "node:test";
import assert from "node:assert/strict";

import {
  assignEditApiKeyProviderSpecificData,
  CLOUD_CODE_PROJECT_ID_PROVIDERS,
} from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/connectionProviderSpecificData.ts";

const BASE_FORM_DATA = {
  accountId: "",
  apiRegion: "international",
  awsAccessKeyId: "",
  awsSessionToken: "",
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
  newApiUserId: "",
  passthroughModels: false,
  region: "",
  routingTags: "",
  tag: "",
  validationModelId: undefined,
};

function editOptions(
  overrides: Partial<Parameters<typeof assignEditApiKeyProviderSpecificData>[0]>
) {
  return {
    provider: "gemini-cli",
    formData: BASE_FORM_DATA,
    target: {} as Record<string, unknown>,
    extraApiKeys: [],
    openRouterPreset: { getPatch: () => ({}) },
    usesBaseUrl: false,
    validatedBaseUrl: null,
    showsRegion: false,
    defaultRegion: "us-east-1",
    isGlm: false,
    isCloudflare: false,
    trimmedCloudCodeProjectId: "",
    isGooglePse: false,
    isCcCompatible: false,
    ...overrides,
  } as Parameters<typeof assignEditApiKeyProviderSpecificData>[0];
}

test("Cloud Code project-id providers include Antigravity and Gemini CLI families", () => {
  for (const provider of ["antigravity", "agy", "gemini-cli", "gemini_cli"]) {
    assert.ok(CLOUD_CODE_PROJECT_ID_PROVIDERS.has(provider), provider);
  }
  assert.equal(CLOUD_CODE_PROJECT_ID_PROVIDERS.has("gemini"), false);
});

for (const provider of ["gemini-cli", "gemini_cli", "antigravity", "agy"]) {
  test(`${provider}: manual project id is saved and flagged isProjectIdManual`, () => {
    const target: Record<string, unknown> = { projectId: "auto-discovered" };
    assignEditApiKeyProviderSpecificData(
      editOptions({ provider, target, trimmedCloudCodeProjectId: "my-gcp-proj" })
    );
    assert.equal(target.projectId, "my-gcp-proj");
    assert.equal(target.isProjectIdManual, true);
  });

  test(`${provider}: clearing the project id resets it to null and drops the manual flag`, () => {
    const target: Record<string, unknown> = { projectId: "old", isProjectIdManual: true };
    assignEditApiKeyProviderSpecificData(editOptions({ provider, target }));
    assert.equal(target.projectId, null);
    assert.equal(target.isProjectIdManual, false);
  });
}

test("non Cloud Code providers ignore the project id field", () => {
  const target: Record<string, unknown> = {};
  assignEditApiKeyProviderSpecificData(
    editOptions({ provider: "openai", target, trimmedCloudCodeProjectId: "my-gcp-proj" })
  );
  assert.equal("projectId" in target, false);
  assert.equal("isProjectIdManual" in target, false);
});
