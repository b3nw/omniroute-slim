/**
 * Comprehensive Unit Tests for Dynamic Provider Alias & Name Overrides
 *
 * Verifies:
 * 1. Environment variable overrides (OMNIROUTE_PROVIDER_ALIAS_OVERRIDES / OMNIROUTE_PROVIDER_ALIASES)
 * 2. Database/programmatic settings overrides (settings.providerAliases / settings.providerAliasOverrides)
 * 3. Wiring into PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS, and ALIAS_TO_PROVIDER_ID
 * 4. parseModel() routing for both overridden and built-in aliases
 * 5. Catalog prefix resolution under MODELS_CATALOG_PREFIX_MODE="alias", "canonical", and "dual"
 * 6. Dynamic hot-reloading and cache invalidation
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-alias-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const {
  setProviderAliasOverrides,
  resetProviderAliasOverrides,
  getRawProviderAliasOverrides,
  parseAliasOverridesInput,
} = await import("../../open-sse/config/providerAliasOverrides.ts");

const {
  PROVIDER_ID_TO_ALIAS,
  PROVIDER_MODELS,
  getProviderModels,
  getModelsByProviderId,
  getProviderModel,
  isValidModel: isValidModelCore,
} = await import("../../open-sse/config/providerModels.ts");

const {
  parseModel,
  resolveProviderAlias,
  resolveCanonicalProviderModel,
  hasKnownProviderModel,
  ALIAS_TO_PROVIDER_ID,
} = await import("../../open-sse/services/model.ts");

const { isValidModel } = await import("../../src/shared/constants/models.ts");

const {
  buildAliasMaps,
  prefixRoutesToProvider,
  getProviderPrefixes,
} = await import("../../src/app/api/v1/models/catalogProviderMaps.ts");

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  resetProviderAliasOverrides();
  delete process.env.OMNIROUTE_PROVIDER_ALIAS_OVERRIDES;
  delete process.env.OMNIROUTE_PROVIDER_ALIASES;
  delete process.env.MODELS_CATALOG_PREFIX_MODE;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  resetProviderAliasOverrides();
  delete process.env.OMNIROUTE_PROVIDER_ALIAS_OVERRIDES;
  delete process.env.OMNIROUTE_PROVIDER_ALIASES;
  delete process.env.MODELS_CATALOG_PREFIX_MODE;
});

// ── 1. Input Parsing & Raw Overrides ───────────────────────────────────────

test("parseAliasOverridesInput handles various input shapes correctly", () => {
  assert.deepEqual(parseAliasOverridesInput(null), {});
  assert.deepEqual(parseAliasOverridesInput(undefined), {});
  assert.deepEqual(parseAliasOverridesInput(""), {});
  assert.deepEqual(parseAliasOverridesInput("invalid-json{"), {});

  const jsonStr = JSON.stringify({ gemini: "google", "ollama-cloud": "ollama_cloud" });
  assert.deepEqual(parseAliasOverridesInput(jsonStr), {
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  const obj = { gemini: " google ", " ollama-cloud ": "ollama_cloud" };
  assert.deepEqual(parseAliasOverridesInput(obj), {
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });
});

test("environment variable OMNIROUTE_PROVIDER_ALIAS_OVERRIDES is picked up", () => {
  process.env.OMNIROUTE_PROVIDER_ALIAS_OVERRIDES = JSON.stringify({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  const overrides = getRawProviderAliasOverrides();
  assert.equal(overrides.gemini, "google");
  assert.equal(overrides["ollama-cloud"], "ollama_cloud");
});

test("environment variable OMNIROUTE_PROVIDER_ALIASES is supported as fallback", () => {
  delete process.env.OMNIROUTE_PROVIDER_ALIAS_OVERRIDES;
  process.env.OMNIROUTE_PROVIDER_ALIASES = JSON.stringify({
    gemini: "google",
    ollamacloud: "ollama_cloud",
  });

  const overrides = getRawProviderAliasOverrides();
  assert.equal(overrides.gemini, "google");
  assert.equal(overrides.ollamacloud, "ollama_cloud");
});

// ── 2. PROVIDER_ID_TO_ALIAS & ALIAS_TO_PROVIDER_ID Resolution ──────────────

test("PROVIDER_ID_TO_ALIAS resolves overridden aliases and built-in aliases", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  assert.equal(PROVIDER_ID_TO_ALIAS.gemini, "google");
  assert.equal(PROVIDER_ID_TO_ALIAS.google, "google");
  assert.equal(PROVIDER_ID_TO_ALIAS["ollama-cloud"], "ollama_cloud");
  assert.equal(PROVIDER_ID_TO_ALIAS.ollamacloud, "ollama_cloud");
  assert.equal(PROVIDER_ID_TO_ALIAS.ollama_cloud, "ollama_cloud");

  // Non-overridden providers retain defaults
  assert.equal(PROVIDER_ID_TO_ALIAS.claude, "cc");
  assert.equal(PROVIDER_ID_TO_ALIAS.github, "gh");
});

test("built-in alias key in overrides correctly remaps the provider", () => {
  setProviderAliasOverrides({
    ollamacloud: "ollama_cloud",
  });

  assert.equal(PROVIDER_ID_TO_ALIAS["ollama-cloud"], "ollama_cloud");
  assert.equal(PROVIDER_ID_TO_ALIAS.ollamacloud, "ollama_cloud");
  assert.equal(PROVIDER_ID_TO_ALIAS.ollama_cloud, "ollama_cloud");
});

test("ALIAS_TO_PROVIDER_ID maps both new overridden aliases and original aliases back to provider ID", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  assert.equal(ALIAS_TO_PROVIDER_ID.google, "gemini");
  assert.equal(ALIAS_TO_PROVIDER_ID.gemini, "gemini");
  assert.equal(ALIAS_TO_PROVIDER_ID.ollama_cloud, "ollama-cloud");
  assert.equal(ALIAS_TO_PROVIDER_ID.ollamacloud, "ollama-cloud");
  assert.equal(ALIAS_TO_PROVIDER_ID["ollama-cloud"], "ollama-cloud");

  // Standard manual slug overrides preserved
  assert.equal(ALIAS_TO_PROVIDER_ID.opencode, "opencode-zen");
  assert.equal(ALIAS_TO_PROVIDER_ID.xiaomi, "xiaomi-mimo");
  assert.equal(ALIAS_TO_PROVIDER_ID.llamacpp, "llama-cpp");
  assert.equal(ALIAS_TO_PROVIDER_ID.agy, "antigravity");
  assert.equal(ALIAS_TO_PROVIDER_ID.aq, "amazon-q");
});

test("resolveProviderAlias resolves new overridden aliases, built-in aliases, and raw provider IDs", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  assert.equal(resolveProviderAlias("google"), "gemini");
  assert.equal(resolveProviderAlias("gemini"), "gemini");
  assert.equal(resolveProviderAlias("ollama_cloud"), "ollama-cloud");
  assert.equal(resolveProviderAlias("ollamacloud"), "ollama-cloud");
  assert.equal(resolveProviderAlias("ollama-cloud"), "ollama-cloud");

  assert.equal(resolveProviderAlias("cc"), "claude");
  assert.equal(resolveProviderAlias("claude"), "claude");
  assert.equal(resolveProviderAlias(null), null);
  assert.equal(resolveProviderAlias(undefined), null);
});

// ── 3. PROVIDER_MODELS Access & Model Registry Helpers ─────────────────────

test("PROVIDER_MODELS exposes overridden alias keys and provides fallback for legacy names", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  const keys = Object.keys(PROVIDER_MODELS);
  assert.ok(keys.includes("google"), "PROVIDER_MODELS keys should include overridden alias 'google'");
  assert.ok(keys.includes("ollama_cloud"), "PROVIDER_MODELS keys should include overridden alias 'ollama_cloud'");
  assert.ok(!keys.includes("gemini"), "PROVIDER_MODELS keys should not contain redundant 'gemini' key");

  // Direct lookups by overridden alias, provider ID, or old alias all succeed
  const googleModels = PROVIDER_MODELS.google;
  assert.ok(Array.isArray(googleModels) && googleModels.length > 0, "PROVIDER_MODELS.google should return models");
  assert.equal(PROVIDER_MODELS.gemini, googleModels, "PROVIDER_MODELS.gemini should resolve to the same models");

  const ollamaModels = PROVIDER_MODELS.ollama_cloud;
  assert.ok(Array.isArray(ollamaModels) && ollamaModels.length > 0, "PROVIDER_MODELS.ollama_cloud should return models");
  assert.equal(PROVIDER_MODELS.ollamacloud, ollamaModels, "PROVIDER_MODELS.ollamacloud should resolve to ollama models");
  assert.equal(PROVIDER_MODELS["ollama-cloud"], ollamaModels, "PROVIDER_MODELS['ollama-cloud'] should resolve to ollama models");
});

test("getProviderModels and getModelsByProviderId resolve models via overridden or legacy aliases", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  const fromGoogle = getProviderModels("google");
  const fromGemini = getProviderModels("gemini");
  assert.ok(fromGoogle.length > 0);
  assert.deepEqual(fromGoogle, fromGemini);

  const byProviderId = getModelsByProviderId("gemini");
  assert.deepEqual(byProviderId, fromGoogle);

  const fromOllamaCloud = getProviderModels("ollama_cloud");
  const fromOllamaLegacy = getProviderModels("ollamacloud");
  const fromOllamaId = getProviderModels("ollama-cloud");
  assert.ok(fromOllamaCloud.length > 0);
  assert.deepEqual(fromOllamaCloud, fromOllamaLegacy);
  assert.deepEqual(fromOllamaCloud, fromOllamaId);
});

test("isValidModel and getProviderModel work with overridden aliases", () => {
  setProviderAliasOverrides({
    gemini: "google",
  });

  const modelEntry = getProviderModel("google", "gemini-2.5-flash");
  assert.ok(modelEntry, "getProviderModel('google', 'gemini-2.5-flash') should find model");
  assert.equal(modelEntry.id, "gemini-2.5-flash");

  assert.equal(isValidModelCore("google", "gemini-2.5-flash"), true);
  assert.equal(isValidModelCore("gemini", "gemini-2.5-flash"), true);
  assert.equal(isValidModel("google", "gemini-2.5-flash"), true);
  assert.equal(isValidModel("gemini", "gemini-2.5-flash"), true);
});

// ── 4. parseModel() Routing Compatibility ──────────────────────────────────

test("parseModel routes both overridden alias prefixes and built-in prefixes seamlessly", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  // Overridden prefix
  const p1 = parseModel("google/gemini-2.5-flash");
  assert.equal(p1.provider, "gemini");
  assert.equal(p1.model, "gemini-2.5-flash");
  assert.equal(p1.providerAlias, "google");
  assert.equal(p1.isAlias, false);

  // Original built-in provider prefix
  const p2 = parseModel("gemini/gemini-2.5-flash");
  assert.equal(p2.provider, "gemini");
  assert.equal(p2.model, "gemini-2.5-flash");
  assert.equal(p2.providerAlias, "gemini");
  assert.equal(p2.isAlias, false);

  // Ollama Cloud overridden prefix
  const p3 = parseModel("ollama_cloud/qwen2.5:7b");
  assert.equal(p3.provider, "ollama-cloud");
  assert.equal(p3.model, "qwen2.5:7b");
  assert.equal(p3.providerAlias, "ollama_cloud");

  // Ollama Cloud built-in alias prefix
  const p4 = parseModel("ollamacloud/qwen2.5:7b");
  assert.equal(p4.provider, "ollama-cloud");
  assert.equal(p4.model, "qwen2.5:7b");
  assert.equal(p4.providerAlias, "ollamacloud");

  // Ollama Cloud canonical ID prefix
  const p5 = parseModel("ollama-cloud/qwen2.5:7b");
  assert.equal(p5.provider, "ollama-cloud");
  assert.equal(p5.model, "qwen2.5:7b");
  assert.equal(p5.providerAlias, "ollama-cloud");

  // Context window marker [1m] preserved with overrides
  const p6 = parseModel("google/gemini-2.5-flash[1m]");
  assert.equal(p6.provider, "gemini");
  assert.equal(p6.model, "gemini-2.5-flash");
  assert.equal(p6.extendedContext, true);
});

test("resolveCanonicalProviderModel and hasKnownProviderModel handle overridden aliases", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  const c1 = resolveCanonicalProviderModel("google", "gemini-2.5-flash");
  assert.deepEqual(c1, { provider: "gemini", model: "gemini-2.5-flash" });

  const c2 = resolveCanonicalProviderModel("gemini", "gemini-2.5-flash");
  assert.deepEqual(c2, { provider: "gemini", model: "gemini-2.5-flash" });

  assert.equal(hasKnownProviderModel("google", "gemini-2.5-flash"), true);
  assert.equal(hasKnownProviderModel("gemini", "gemini-2.5-flash"), true);
  assert.equal(hasKnownProviderModel("google", "nonexistent-model-xyz"), false);
});

// ── 5. Catalog Maps & Prefix Resolution ────────────────────────────────────

test("buildAliasMaps produces correct mapping when aliases are overridden", () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });

  const { aliasToProviderId, providerIdToAlias } = buildAliasMaps();

  assert.equal(providerIdToAlias.gemini, "google");
  assert.equal(providerIdToAlias["ollama-cloud"], "ollama_cloud");

  assert.equal(aliasToProviderId.google, "gemini");
  assert.equal(aliasToProviderId.gemini, "gemini");
  assert.equal(aliasToProviderId.ollama_cloud, "ollama-cloud");
  assert.equal(aliasToProviderId.ollamacloud, "ollama-cloud");
  assert.equal(aliasToProviderId["ollama-cloud"], "ollama-cloud");

  assert.equal(prefixRoutesToProvider("google", "gemini"), true);
  assert.equal(prefixRoutesToProvider("gemini", "gemini"), true);
  assert.equal(prefixRoutesToProvider("ollama_cloud", "ollama-cloud"), true);
  assert.equal(prefixRoutesToProvider("ollamacloud", "ollama-cloud"), true);
});

test("getProviderPrefixes returns all routable prefixes including overridden alias", () => {
  setProviderAliasOverrides({
    gemini: "google",
  });

  const maps = buildAliasMaps();
  const prefixes = getProviderPrefixes(maps, "gemini", "gemini");

  assert.ok(prefixes.includes("google"), "prefixes should include overridden alias 'google'");
  assert.ok(prefixes.includes("gemini"), "prefixes should include canonical provider 'gemini'");
});

// ── 6. Full /v1/models Catalog Response Tests ──────────────────────────────

test("/v1/models advertises overridden alias prefix when MODELS_CATALOG_PREFIX_MODE=alias", async () => {
  setProviderAliasOverrides({
    gemini: "google",
    "ollama-cloud": "ollama_cloud",
  });
  process.env.MODELS_CATALOG_PREFIX_MODE = "alias";

  // Create an active connection for gemini and ollama-cloud
  await providersDb.createProviderConnection({
    provider: "gemini",
    apiKey: "test-gemini-key",
    isActive: true,
  });

  await providersDb.createProviderConnection({
    provider: "ollama-cloud",
    apiKey: "test-ollama-key",
    isActive: true,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost:3000/v1/models?prefix=alias")
  );
  assert.equal(response.status, 200);

  const payload = await response.json();
  const modelIds: string[] = payload.data.map((m: { id: string }) => m.id);

  // Check gemini models are advertised under google/*
  assert.ok(modelIds.includes("google/gemini-2.5-flash"), "Catalog should include 'google/gemini-2.5-flash'");
  assert.ok(!modelIds.includes("gemini/gemini-2.5-flash"), "Catalog should not include 'gemini/gemini-2.5-flash' when prefixMode=alias");

  // Check ownership is still the canonical provider ID
  const sampleGoogleModel = payload.data.find((m: { id: string }) => m.id === "google/gemini-2.5-flash");
  assert.ok(sampleGoogleModel, "google/gemini-2.5-flash should exist");
  assert.equal(sampleGoogleModel.owned_by, "gemini");

  // Check ollama-cloud models are advertised under ollama_cloud/*
  assert.ok(modelIds.includes("ollama_cloud/gpt-oss:20b"), "Catalog should include 'ollama_cloud/gpt-oss:20b'");
  assert.ok(!modelIds.includes("ollamacloud/gpt-oss:20b"), "Catalog should not include 'ollamacloud/gpt-oss:20b' when prefixMode=alias");
  assert.ok(!modelIds.includes("ollama-cloud/gpt-oss:20b"), "Catalog should not include 'ollama-cloud/gpt-oss:20b' when prefixMode=alias");

  const sampleOllamaModel = payload.data.find((m: { id: string }) => m.id === "ollama_cloud/gpt-oss:20b");
  assert.ok(sampleOllamaModel, "ollama_cloud/gpt-oss:20b should exist");
  assert.equal(sampleOllamaModel.owned_by, "ollama-cloud");
});

test("/v1/models advertises canonical prefix when MODELS_CATALOG_PREFIX_MODE=canonical", async () => {
  setProviderAliasOverrides({
    gemini: "google",
  });
  process.env.MODELS_CATALOG_PREFIX_MODE = "canonical";

  await providersDb.createProviderConnection({
    provider: "gemini",
    apiKey: "test-gemini-key",
    isActive: true,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost:3000/v1/models?prefix=canonical")
  );
  assert.equal(response.status, 200);

  const payload = await response.json();
  const modelIds: string[] = payload.data.map((m: { id: string }) => m.id);

  assert.ok(modelIds.includes("gemini/gemini-2.5-flash"), "Catalog should include 'gemini/gemini-2.5-flash' in canonical mode");
  assert.ok(!modelIds.includes("google/gemini-2.5-flash"), "Catalog should not include 'google/gemini-2.5-flash' in canonical mode");
});

test("/v1/models advertises both overridden alias and canonical when prefix=dual", async () => {
  setProviderAliasOverrides({
    gemini: "google",
  });

  await providersDb.createProviderConnection({
    provider: "gemini",
    apiKey: "test-gemini-key",
    isActive: true,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost:3000/v1/models?prefix=dual")
  );
  assert.equal(response.status, 200);

  const payload = await response.json();
  const modelIds: string[] = payload.data.map((m: { id: string }) => m.id);

  assert.ok(modelIds.includes("google/gemini-2.5-flash"), "Dual mode should include google/gemini-2.5-flash");
  assert.ok(modelIds.includes("gemini/gemini-2.5-flash"), "Dual mode should include gemini/gemini-2.5-flash");
});

test("database settings providerAliases overrides are dynamically applied", async () => {
  await settingsDb.updateSettings({
    providerAliases: {
      gemini: "google_corp",
    },
  });

  await providersDb.createProviderConnection({
    provider: "gemini",
    apiKey: "test-gemini-key",
    isActive: true,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost:3000/v1/models?prefix=alias")
  );
  assert.equal(response.status, 200);

  const payload = await response.json();
  const modelIds: string[] = payload.data.map((m: { id: string }) => m.id);

  const googleCorpPrefixed = modelIds.filter((id) => id.startsWith("google_corp/"));
  assert.ok(googleCorpPrefixed.length > 0, "Catalog should advertise 'google_corp/' from database settings");

  const parsed = parseModel("google_corp/gemini-2.5-flash");
  assert.equal(parsed.provider, "gemini");
  assert.equal(parsed.model, "gemini-2.5-flash");
});
