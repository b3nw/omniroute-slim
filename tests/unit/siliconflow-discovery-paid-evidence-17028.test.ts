import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Synthetic catalog entries test the contract, not current SiliconFlow availability/billing.
// Isolate storage before importing any application module (normalizers import DB helpers).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-siliconflow-evidence-17028-"));
process.env.DATA_DIR = dataDir;

const { normalizeOpenAiLikeModelsResponse } =
  await import("../../src/app/api/providers/[id]/models/discovery/normalizers.ts");
const { isFreeModel, selectModelsForImport } = await import("../../src/shared/utils/freeModels.ts");
const { hasPayloadPaidEvidence } = await import("../../src/shared/utils/payloadFreeEvidence.ts");
const { normalizeDiscoveredModels } = await import("../../src/lib/providerModels/modelDiscovery.ts");
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const syncRoute = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
const { buildModelSyncInternalHeaders } =
  await import("../../src/shared/services/modelSyncScheduler.ts");

const originalFetch = globalThis.fetch;

const free = {
  id: "fixture-siliconflow-free",
  isFree: true,
  pricing: { prompt: "0", completion: "0" },
};
const zeroOnly = {
  id: "fixture-siliconflow-zero-only",
  pricing: { input: "0", output: "0" },
};
const pricedSuffix = {
  id: "fixture-siliconflow-priced:free",
  isFree: true,
  pricing: { prompt: "4", completion: "16" },
};
const paidFlagSuffix = {
  id: "fixture-siliconflow-paid-flag:free",
  isFree: true,
  free: false,
  pricing: { prompt: "0", completion: "0" },
};
const pricedPlain = {
  id: "fixture-siliconflow-priced-plain",
  isFree: true,
  pricing: { prompt: "4", completion: "16" },
};
const unknown = { id: "fixture-siliconflow-unknown" };

type CatalogFixture = { id: string; [key: string]: unknown };

function normalized(model: CatalogFixture) {
  const result = normalizeOpenAiLikeModelsResponse({ data: [model] }, "siliconflow");
  assert.equal(result.length, 1, "the discovery normalizer must retain the catalog entry");
  return result[0] as CatalogFixture;
}

function assertFreeDecision(model: CatalogFixture, expected: boolean) {
  assert.equal(isFreeModel("siliconflow", model), expected, `${model.id}: free predicate`);
  const selected = selectModelsForImport("siliconflow", [model], true);
  assert.deepEqual(
    selected.models.map((entry) => entry.id),
    expected ? [model.id] : []
  );
  assert.equal(selected.freeFilterEmpty, !expected);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#17028 control: raw free/paid evidence already produces the required decisions", () => {
  assertFreeDecision(free, true);
  assertFreeDecision(zeroOnly, true);
  for (const model of [pricedSuffix, paidFlagSuffix, pricedPlain, unknown]) {
    assertFreeDecision(model, false);
  }
  assert.equal(hasPayloadPaidEvidence(pricedSuffix), true);
  assert.equal(hasPayloadPaidEvidence(paidFlagSuffix), true);
  assert.equal(hasPayloadPaidEvidence(free), false);
  assert.equal(hasPayloadPaidEvidence(unknown), false);
});

test("#17028 discovery retains explicit free and zero-price evidence for import", () => {
  assertFreeDecision(normalized(free), true);
  assertFreeDecision(normalized(zeroOnly), true);
});

test("#17028 discovery retains positive-price veto despite an optimistic :free suffix", () => {
  assertFreeDecision(normalized(pricedSuffix), false);
});

test("#17028 discovery retains explicit paid veto despite zero prices and :free suffix", () => {
  assertFreeDecision(normalized(paidFlagSuffix), false);
});

test("#17028 controls: exclude paid/unknown, omit arbitrary fields, other providers unchanged", () => {
  assertFreeDecision(normalized(pricedPlain), false);
  assertFreeDecision(normalized(unknown), false);
  const model = normalized({
    ...free,
    internalSecret: "fixture-only-must-not-be-projected",
  });
  assert.equal("internalSecret" in model, false);
  const [otherProvider] = normalizeOpenAiLikeModelsResponse(
    {
      data: [
        {
          ...free,
          owned_by: "siliconflow",
          provider: "siliconflow",
          is_free: true,
          free: true,
          tags: ["free"],
        },
      ],
    },
    "reka"
  );
  assert.ok(otherProvider);
  for (const key of ["pricing", "isFree", "is_free", "free", "tags"]) {
    assert.equal(key in otherProvider, false, `${key} must not alter other provider projections`);
  }
});

test("#17028 normalizeDiscoveredModels persists the SiliconFlow economics verdict", () => {
  const discovered = normalizeDiscoveredModels(
    [free, zeroOnly, pricedSuffix, paidFlagSuffix, pricedPlain, unknown].map(normalized),
    "siliconflow"
  );
  const byId = new Map(discovered.map((model) => [model.id, model]));
  assert.equal(byId.get(free.id)?.isFree, true);
  assert.equal(byId.get(zeroOnly.id)?.isFree, true);
  assert.equal(byId.get(pricedSuffix.id)?.isFree, false);
  assert.equal(byId.get(paidFlagSuffix.id)?.isFree, false);
  assert.equal(byId.get(pricedPlain.id)?.isFree, false);
  assert.equal("isFree" in (byId.get(unknown.id) ?? {}), false);

  // Other providers keep their historical shape: no economics verdict is stamped.
  const [other] = normalizeDiscoveredModels([pricedSuffix], "reka");
  assert.equal("isFree" in other, false);
});

test("#17028 cache round-trip keeps paid plain and :free IDs excluded", async () => {
  const row = await providers.createProviderConnection({
    provider: "siliconflow",
    authType: "apikey",
    name: "SiliconFlow discovery evidence cache fixture",
    apiKey: "fixture-not-a-real-api-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: "https://api.siliconflow.cn/v1" },
  });
  const entries = [free, pricedPlain, pricedSuffix, paidFlagSuffix, unknown];
  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "siliconflow",
    row.id,
    normalizeDiscoveredModels(entries.map(normalized), "siliconflow")
  );

  // The cache stores only the verdict (no pricing): the paid veto must survive it.
  const cached = (await modelsDb.getSyncedAvailableModelsForConnection(
    "siliconflow",
    row.id
  )) as CatalogFixture[];
  const byId = new Map(cached.map((model) => [model.id, model]));
  for (const [id, expected] of [
    [free.id, true],
    [unknown.id, false],
    [pricedPlain.id, false],
    [pricedSuffix.id, false],
    [paidFlagSuffix.id, false],
  ] as const) {
    const model = byId.get(id);
    assert.ok(model, `cache must return ${id}`);
    assertFreeDecision(model, expected);
  }
});

test("#17028 sync POST with importFreeModelsOnly imports only the genuinely free entry", async () => {
  const row = await providers.createProviderConnection({
    provider: "siliconflow",
    authType: "apikey",
    name: "SiliconFlow discovery evidence sync fixture",
    apiKey: "fixture-not-a-real-api-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      baseUrl: "https://api.siliconflow.cn/v1",
      importFreeModelsOnly: true,
    },
  });
  const discoveredModels = [free, pricedSuffix, paidFlagSuffix, unknown].map(normalized);

  // Replace only the self-HTTP discovery hop; the sync route, free predicates and
  // SQLite domain APIs stay on the real path.
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("__readiness_probe__")) return new Response("", { status: 404 });
    return Response.json({
      provider: "siliconflow",
      connectionId: row.id,
      source: "api",
      models: discoveredModels,
    });
  };

  const response = await syncRoute.POST(
    new Request(`http://127.0.0.1/api/providers/${row.id}/sync-models`, {
      method: "POST",
      headers: buildModelSyncInternalHeaders(),
    }),
    { params: Promise.resolve({ id: row.id }) }
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; freeFilterEmpty: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.freeFilterEmpty, false);
  const persisted = await modelsDb.getSyncedAvailableModelsForConnection("siliconflow", row.id);
  assert.deepEqual(
    persisted.map((model) => model.id),
    [free.id]
  );
});
