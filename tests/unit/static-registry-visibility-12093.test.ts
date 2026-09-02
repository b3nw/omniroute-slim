/**
 * #12093 — Operators must be able to hide static `PROVIDER_MODELS` registry
 * entries that have no synced row.
 *
 * Un-synced static models are intentionally preserved in `GET /v1/models` so the
 * gateway keeps routing them (#9217, and the partial-discovery carve-out in
 * `catalogSyncedCoverage.ts`). That left operators with no way to drop a static
 * entry from the advertised catalog: with no dashboard row there was nothing to
 * toggle, and the hidden flag has no custom-model row to live on.
 *
 * The pieces this locks down:
 *  - `PATCH /api/provider-models` persists `isHidden` to `modelCompatOverrides`
 *    (NOT a synthesized custom-model row) when the model is static-only.
 *  - `catalog.ts`'s static `PROVIDER_MODELS` pass consults that override through
 *    `isModelHiddenBulk()`, so the model leaves `GET /v1/models` — including when
 *    the write key (`command-code`) differs from the key the static loop reads
 *    (`cmd`).
 *  - Un-overridden static models stay listed and routable (#9217 preserved).
 *  - `mergeProviderModelListing()` surfaces static-only entries in the provider
 *    dashboard table and badges their origin apart from synced/custom rows.
 *
 * `command-code` (id `command-code`, alias `cmd`) is the fixture provider: it has
 * a static registry, is NOT an authoritative-live-catalog provider, and its alias
 * differs from its id — so a partial sync keeps its un-covered static models
 * listed, which is exactly the state this feature has to control.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-12093-static-visibility-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providerModelsRoute = await import("../../src/app/api/provider-models/route.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const { getModelsByProviderId } = await import("../../open-sse/config/providerModels.ts");
const { getAllStaticModelsForProvider } = await import("@/lib/providers/staticModels");
const { mergeProviderModelListing } = await import("@/lib/providers/mergeProviderModelListing");
const { getModelCatalogSourceLabel, matchesModelCatalogQuery, normalizeModelCatalogSource } =
  await import("@/shared/utils/modelCatalogSearch");

const PROVIDER_ID = "command-code";
const PROVIDER_ALIAS = "cmd";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function connectProvider() {
  return providersDb.createProviderConnection({
    provider: PROVIDER_ID,
    authType: "apikey",
    name: "command-code-main",
    apiKey: "sk-test-12093",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

async function fetchCatalogIds(): Promise<string[]> {
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.ok(Array.isArray(body.data), "response has data array");
  return body.data.map((m) => m.id);
}

/**
 * Static registry ids the catalog actually advertises right now, so the
 * assertions below never depend on a hand-copied model id that registry drift
 * can retire out from under them.
 */
function listedStaticModelIds(catalogIds: string[]): string[] {
  const listed = new Set(catalogIds);
  return getModelsByProviderId(PROVIDER_ID)
    .map((model) => model.id)
    .filter((id) => listed.has(`${PROVIDER_ALIAS}/${id}`));
}

function patchVisibility(body: Record<string, unknown>, modelId?: string) {
  const url = modelId
    ? `http://localhost/api/provider-models?provider=${encodeURIComponent(PROVIDER_ID)}&modelId=${encodeURIComponent(modelId)}`
    : `http://localhost/api/provider-models?provider=${encodeURIComponent(PROVIDER_ID)}`;
  return providerModelsRoute.PATCH(
    new Request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Toggle persistence + catalog exclusion
// ───────────────────────────────────────────────────────────────────────────────

test("#12093: hiding a static-only model persists to modelCompatOverrides and drops it from /v1/models", async () => {
  await connectProvider();

  const staticIds = listedStaticModelIds(await fetchCatalogIds());
  assert.ok(
    staticIds.length >= 2,
    `expected command-code to advertise at least 2 static models — got ${staticIds.length}`
  );
  const [target, sibling] = staticIds;

  const response = await patchVisibility({ isHidden: true }, target);
  assert.equal(response.status, 200);

  // The override must land on the compat-override list — a static model has no
  // custom-model row, and synthesizing one would pollute the custom registry
  // (the workaround #12093 explicitly rejects).
  const overrides = modelsDb.getModelCompatOverrides(PROVIDER_ID);
  assert.deepEqual(
    overrides.find((entry: { id: string }) => entry.id === target),
    { id: target, isHidden: true },
    `expected a modelCompatOverrides entry for ${target} — got ${JSON.stringify(overrides)}`
  );
  assert.deepEqual(
    await modelsDb.getCustomModels(PROVIDER_ID),
    [],
    "hiding a static model must not create a custom-model row"
  );

  const idsAfterHide = await fetchCatalogIds();
  assert.ok(
    !idsAfterHide.includes(`${PROVIDER_ALIAS}/${target}`),
    `expected ${PROVIDER_ALIAS}/${target} to be dropped from /v1/models after hiding`
  );
  // Acceptance criterion: un-overridden static models stay visible (#9217).
  assert.ok(
    idsAfterHide.includes(`${PROVIDER_ALIAS}/${sibling}`),
    `expected the un-hidden sibling ${PROVIDER_ALIAS}/${sibling} to remain listed`
  );
});

test("#12093: the hidden flag is written under the canonical provider id and read via the alias", async () => {
  await connectProvider();

  const [target] = listedStaticModelIds(await fetchCatalogIds());
  assert.ok(target, "expected at least one listed static model");

  await patchVisibility({ isHidden: true }, target);

  // The dashboard PATCHes with the canonical id (`command-code`); the catalog's
  // static loop is keyed by the public alias (`cmd`). The bulk lookup has to
  // bridge the two — see #11300.
  assert.equal(modelsDb.getModelCompatOverrides(PROVIDER_ALIAS).length, 0);
  assert.deepEqual([...(modelsDb.getHiddenModelsByProvider().get(PROVIDER_ID) ?? [])], [target]);
  assert.ok(!(await fetchCatalogIds()).includes(`${PROVIDER_ALIAS}/${target}`));
});

test("#12093: un-hiding a static model restores it to /v1/models", async () => {
  await connectProvider();

  const [target] = listedStaticModelIds(await fetchCatalogIds());
  await patchVisibility({ isHidden: true }, target);
  assert.ok(!(await fetchCatalogIds()).includes(`${PROVIDER_ALIAS}/${target}`));

  const response = await patchVisibility({ isHidden: false }, target);
  assert.equal(response.status, 200);

  assert.equal(
    modelsDb.getModelIsHidden(PROVIDER_ID, target),
    false,
    "the override must read back as visible"
  );
  assert.ok(
    (await fetchCatalogIds()).includes(`${PROVIDER_ALIAS}/${target}`),
    `expected ${PROVIDER_ALIAS}/${target} back in /v1/models after un-hiding`
  );
});

test("#12093: bulk-hiding static models removes every one of them from /v1/models", async () => {
  await connectProvider();

  const staticIds = listedStaticModelIds(await fetchCatalogIds());
  assert.ok(staticIds.length >= 3, "expected at least 3 listed static models");
  const targets = staticIds.slice(0, 2);
  const survivor = staticIds[2];

  const response = await patchVisibility({ isHidden: true, modelIds: targets });
  assert.equal(response.status, 200);

  const ids = await fetchCatalogIds();
  for (const target of targets) {
    assert.ok(
      !ids.includes(`${PROVIDER_ALIAS}/${target}`),
      `expected bulk-hidden ${target} to leave the catalog`
    );
  }
  assert.ok(ids.includes(`${PROVIDER_ALIAS}/${survivor}`), "untouched static model stays listed");
});

test("#12093: a static model the live sync does not cover stays listed until the operator hides it", async () => {
  const connection = await connectProvider();

  const staticIds = listedStaticModelIds(await fetchCatalogIds());
  assert.ok(staticIds.length >= 2, "expected at least 2 listed static models");
  const syncedStatic = staticIds[0];
  const unsyncedStatic = staticIds[1];

  // Partial discovery: upstream returns one of the static models plus a model the
  // registry never declared. `command-code` is not an authoritative-live-catalog
  // provider, so its un-covered static routes survive the sync.
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER_ID, connection.id, [
    { id: syncedStatic, name: syncedStatic },
    { id: "discovered-only-model", name: "discovered-only-model" },
  ] as never);

  const idsAfterSync = await fetchCatalogIds();
  assert.ok(
    idsAfterSync.includes(`${PROVIDER_ALIAS}/${unsyncedStatic}`),
    `expected the un-synced static model ${unsyncedStatic} to stay listed after a partial sync (#9217)`
  );

  await patchVisibility({ isHidden: true }, unsyncedStatic);

  const idsAfterHide = await fetchCatalogIds();
  assert.ok(
    !idsAfterHide.includes(`${PROVIDER_ALIAS}/${unsyncedStatic}`),
    "expected the hidden un-synced static model to leave /v1/models"
  );
  assert.ok(
    idsAfterHide.includes(`${PROVIDER_ALIAS}/${syncedStatic}`),
    "the synced model must be unaffected"
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// Dashboard listing: static entries are surfaced and badged apart
// ───────────────────────────────────────────────────────────────────────────────

test("#12093: the dashboard listing surfaces un-synced static models with a distinct origin", () => {
  const registryModels = [
    { id: "static-and-synced", name: "Static And Synced" },
    { id: "static-only", name: "Static Only" },
  ];

  const merged = mergeProviderModelListing({
    providerId: PROVIDER_ID,
    registryModels,
    syncedModels: [
      { id: "static-and-synced", name: "Static And Synced" },
      { id: "discovered-only", name: "Discovered Only" },
    ],
    customModels: [{ id: "hand-added", name: "Hand Added", source: "manual" }],
  });

  const bySource = Object.fromEntries(merged.map((model) => [model.id, model.source]));
  assert.deepEqual(bySource, {
    // Present in the registry but absent from the live sync → the row the
    // operator needs to be able to find and hide.
    "static-only": "static",
    // Registry entry the sync confirmed → an ordinary built-in.
    "static-and-synced": "system",
    "discovered-only": "imported",
    "hand-added": "custom",
  });
});

test("#12093: with no synced catalog every registry row stays a plain built-in", () => {
  const merged = mergeProviderModelListing({
    providerId: PROVIDER_ID,
    registryModels: [{ id: "static-a" }, { id: "static-b" }],
    syncedModels: [],
    customModels: [],
  });

  assert.deepEqual(
    merged.map((model) => model.source),
    ["system", "system"],
    "without a sync there is no synced/un-synced distinction to draw"
  );
});

test("#12093: static-only rows carry the operator's hidden state into the dashboard table", () => {
  const merged = mergeProviderModelListing({
    providerId: PROVIDER_ID,
    registryModels: [{ id: "static-only" }, { id: "static-and-synced" }],
    syncedModels: [{ id: "static-and-synced" }],
    customModels: [],
  });

  // What ProviderModelsSection derives per row: `effectiveModelHidden` is fed by
  // the modelCompatOverrides list the PATCH above writes.
  const overrides = new Map([["static-only", { id: "static-only", isHidden: true }]]);
  const withVisibility = merged.map((model) => ({
    ...model,
    isHidden: Boolean(overrides.get(model.id)?.isHidden),
  }));

  assert.deepEqual(
    withVisibility.map((m) => [m.id, m.source, m.isHidden]),
    [
      ["static-only", "static", true],
      ["static-and-synced", "system", false],
    ]
  );
  // The "hidden" filter in the toolbar has to catch the static row.
  assert.deepEqual(
    withVisibility.filter((m) => m.isHidden).map((m) => m.id),
    ["static-only"]
  );
});

test("#12093: the static origin has its own badge label and is searchable", () => {
  assert.equal(normalizeModelCatalogSource("static"), "static");
  assert.equal(getModelCatalogSourceLabel("static"), "Static Registry");
  // Un-tagged rows keep the existing "Built-in" badge.
  assert.equal(getModelCatalogSourceLabel("system"), "Built-in");

  assert.ok(
    matchesModelCatalogQuery("static registry", { modelId: "static-only", source: "static" }),
    "the model filter must find static rows by origin"
  );
  assert.ok(
    !matchesModelCatalogQuery("static registry", { modelId: "synced-row", source: "imported" }),
    "the origin search must not sweep in synced rows"
  );
});

test("#12093: getAllStaticModelsForProvider includes specialty modality registry models and deduplicates", async () => {
  const { getEmbeddingProvider } = await import("@omniroute/open-sse/config/embeddingRegistry.ts");
  const { getImageProvider } = await import("@omniroute/open-sse/config/imageRegistry.ts");
  const { getRerankProvider } = await import("@omniroute/open-sse/config/rerankRegistry.ts");

  const geminiModels = getAllStaticModelsForProvider("gemini");
  const geminiIds = geminiModels.map((m) => m.id);

  // Check deduplication
  const geminiUniqueIds = new Set(geminiIds);
  assert.equal(geminiIds.length, geminiUniqueIds.size, "all model IDs must be unique");

  // Structural check: all embedding models defined in embeddingRegistry must be included
  const geminiEmbeddings = getEmbeddingProvider("gemini")?.models ?? [];
  for (const emb of geminiEmbeddings) {
    assert.ok(
      geminiIds.includes(emb.id),
      `expected embedding model ${emb.id} to be present in getAllStaticModelsForProvider("gemini")`
    );
  }

  const nvidiaModels = getAllStaticModelsForProvider("nvidia");
  const nvidiaIds = nvidiaModels.map((m) => m.id);

  // Check deduplication
  const nvidiaUniqueIds = new Set(nvidiaIds);
  assert.equal(nvidiaIds.length, nvidiaUniqueIds.size, "all nvidia model IDs must be unique");

  // Structural check: all image and rerank models defined in image/rerank registries must be included
  const nvidiaImages = getImageProvider("nvidia")?.models ?? [];
  for (const img of nvidiaImages) {
    assert.ok(
      nvidiaIds.includes(img.id),
      `expected image model ${img.id} to be present in getAllStaticModelsForProvider("nvidia")`
    );
  }

  const nvidiaReranks = getRerankProvider("nvidia")?.models ?? [];
  for (const rrk of nvidiaReranks) {
    assert.ok(
      nvidiaIds.includes(rrk.id),
      `expected rerank model ${rrk.id} to be present in getAllStaticModelsForProvider("nvidia")`
    );
  }
});
