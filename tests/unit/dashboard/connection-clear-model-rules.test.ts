// Clearing tag / routing tags / excludedModels / allowedModels in the Edit Connection
// modal must actually clear them. The edit payload used to send `undefined` for an
// emptied field; JSON.stringify drops undefined keys, so the PUT route's partial
// merge (`{ ...existingPsd, ...incomingPsd }`) silently kept the stored value and
// the operator could never remove an exclusion once saved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { assignEditApiKeyProviderSpecificData } from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/connectionProviderSpecificData.ts";
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

const STORED_PSD = {
  tag: "team-a",
  tags: ["fast", "cheap"],
  excludedModels: ["gpt-5-pro", "o3*"],
  allowedModels: ["gpt-5*"],
  someOtherSetting: "keep-me",
};

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
    trimmedCloudCodeProjectId: "",
    isGooglePse: false,
    isCcCompatible: false,
  };
}

// Mirrors PUT /api/providers/[id]: the client payload goes over the wire as JSON,
// then is shallow-merged onto the stored providerSpecificData and normalized.
function simulatePut(existing: Record<string, unknown>, payload: Record<string, unknown>) {
  const incoming = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  return normalizeProviderSpecificData("openai", { ...existing, ...incoming }) || {};
}

function validationIssues(data: Record<string, unknown>) {
  const result = z
    .record(z.string(), z.unknown())
    .superRefine((value, ctx) => validateProviderSpecificData(value, ctx))
    .safeParse(data);
  return result.success ? [] : result.error.issues;
}

test("emptied fields are sent as explicit empty values, not undefined", () => {
  const target: Record<string, unknown> = { ...STORED_PSD };
  assignEditApiKeyProviderSpecificData(editOptions(BASE_FORM_DATA, target));

  assert.equal(target.tag, "");
  assert.deepEqual(target.tags, []);
  assert.deepEqual(target.excludedModels, []);
  assert.deepEqual(target.allowedModels, []);

  // Survives serialization — the keys must reach the server.
  const wire = JSON.parse(JSON.stringify(target));
  for (const key of ["tag", "tags", "excludedModels", "allowedModels"]) {
    assert.ok(key in wire, `${key} must survive JSON serialization`);
  }
});

test("clearing all four fields through the PUT merge removes the stored values", () => {
  const target: Record<string, unknown> = { ...STORED_PSD };
  assignEditApiKeyProviderSpecificData(editOptions(BASE_FORM_DATA, target));
  const persisted = simulatePut(STORED_PSD, target);

  assert.equal("tag" in persisted, false, "tag must be cleared");
  assert.equal("tags" in persisted, false, "routing tags must be cleared");
  assert.equal("excludedModels" in persisted, false, "excludedModels must be cleared");
  assert.equal("allowedModels" in persisted, false, "allowedModels must be cleared");
  assert.equal(persisted.someOtherSetting, "keep-me", "unrelated keys survive the merge");
});

test("whitespace-only inputs also clear the stored values", () => {
  const target: Record<string, unknown> = { ...STORED_PSD };
  assignEditApiKeyProviderSpecificData(
    editOptions(
      {
        ...BASE_FORM_DATA,
        tag: "   ",
        routingTags: " , ",
        excludedModels: " ,, ",
        allowedModels: " ",
      },
      target
    )
  );
  const persisted = simulatePut(STORED_PSD, target);
  for (const key of ["tag", "tags", "excludedModels", "allowedModels"]) {
    assert.equal(key in persisted, false, `${key} must be cleared`);
  }
});

test("non-empty edits still replace the stored values", () => {
  const target: Record<string, unknown> = { ...STORED_PSD };
  assignEditApiKeyProviderSpecificData(
    editOptions(
      {
        ...BASE_FORM_DATA,
        tag: "  team-b ",
        routingTags: "Slow, slow, gpu",
        excludedModels: "gpt-4*, gpt-4*",
        allowedModels: "gpt-4.1",
      },
      target
    )
  );
  const persisted = simulatePut(STORED_PSD, target);
  assert.equal(persisted.tag, "team-b");
  assert.deepEqual(persisted.tags, ["slow", "gpu"]);
  assert.deepEqual(persisted.excludedModels, ["gpt-4*"]);
  assert.deepEqual(persisted.allowedModels, ["gpt-4.1"]);
});

test("the explicit empty payload passes providerSpecificData validation", () => {
  assert.deepEqual(
    validationIssues({ tag: "", tags: [], excludedModels: [], allowedModels: [] }),
    []
  );
});

test("legacy undefined payload would NOT clear (documents the original bug)", () => {
  const persisted = simulatePut(STORED_PSD, {
    tag: undefined,
    tags: undefined,
    excludedModels: undefined,
    allowedModels: [],
  });
  assert.equal(persisted.tag, "team-a");
  assert.deepEqual(persisted.excludedModels, ["gpt-5-pro", "o3*"]);
});

test("EditConnectionModal OAuth branch sends explicit empty values for cleared fields", () => {
  // The OAuth edit path builds its payload inline in the component (React/UI
  // imports keep it out of node:test), so guard the exact expressions.
  const source = fs.readFileSync(
    path.resolve(
      "src/app/(dashboard)/dashboard/providers/[id]/components/modals/EditConnectionModal.tsx"
    ),
    "utf8"
  );
  assert.match(source, /tag: formData\.tag\.trim\(\),/);
  assert.match(source, /tags: parseRoutingTagsInput\(formData\.routingTags\) \?\? \[\],/);
  assert.match(
    source,
    /excludedModels: parseExcludedModelsInput\(formData\.excludedModels\) \?\? \[\],/
  );
  assert.match(
    source,
    /allowedModels: parseAllowedModelsInput\(formData\.allowedModels\) \?\? \[\],/
  );
  assert.doesNotMatch(source, /tag: formData\.tag\.trim\(\) \|\| undefined/);
});
